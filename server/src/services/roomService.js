import mongoose from 'mongoose';
import Room from '../models/Room.js';
import Message, { serializeMessage } from '../models/Message.js';
import { getRoomIfMember } from './roomAccess.js';
import { defaultStorageService } from './storage.js';

export const MAX_ROOMS_PER_USER = 50;
export const MAX_MEMBERS_PER_ROOM = 100;

export function serializeRoomMember(member) {
  const userObj =
    member.user && typeof member.user === 'object' && member.user.username
      ? { id: member.user._id.toString(), username: member.user.username }
      : { id: member.user.toString(), username: undefined };

  return {
    user: userObj,
    role: member.role,
    muted: Boolean(member.muted),
    notificationLevel: member.notificationLevel || (member.muted ? 'muted' : 'all'),
    joinedAt: member.joinedAt instanceof Date ? member.joinedAt.toISOString() : member.joinedAt,
    lastReadAt:
      member.lastReadAt instanceof Date ? member.lastReadAt.toISOString() : member.lastReadAt,
  };
}

export function serializeRoom(roomDoc, currentUserId, { lastMessage = null, unreadCount = 0 } = {}) {
  const members = (roomDoc.members || []).map(serializeRoomMember);
  let otherUser = null;
  if (roomDoc.type === 'dm') {
    const other = members.find((m) => m.user.id !== currentUserId.toString());
    otherUser = other ? other.user : null;
  }

  return {
    _id: roomDoc._id.toString(),
    name: roomDoc.type === 'dm' ? otherUser?.username || 'Direct Message' : roomDoc.name,
    type: roomDoc.type,
    createdBy: roomDoc.createdBy ? roomDoc.createdBy.toString() : null,
    members,
    otherUser,
    slowModeSeconds: roomDoc.slowModeSeconds || 0,
    announcementMode: Boolean(roomDoc.announcementMode),
    maxMembers: roomDoc.maxMembers || MAX_MEMBERS_PER_ROOM,
    allowInviteLinks: roomDoc.allowInviteLinks !== false,
    pinnedMessages: (roomDoc.pinnedMessages || []).map((id) => id.toString()),
    lastMessage,
    unreadCount,
    createdAt:
      roomDoc.createdAt instanceof Date ? roomDoc.createdAt.toISOString() : roomDoc.createdAt,
    updatedAt:
      roomDoc.updatedAt instanceof Date ? roomDoc.updatedAt.toISOString() : roomDoc.updatedAt,
  };
}

/**
 * Fetches all rooms the user belongs to, enriched with lastMessage preview,
 * unreadCount, and DM partner details.
 */
export async function getRoomsWithPreviews(userId) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const rooms = await Room.find({ 'members.user': userObjectId })
    .populate('members.user', 'username')
    .lean();

  if (rooms.length === 0) return [];

  const roomIds = rooms.map((r) => r._id);

  // Single aggregation to grab the newest message per room using the { room: 1, createdAt: -1 } index.
  const latestAgg = await Message.aggregate([
    { $match: { room: { $in: roomIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$room', doc: { $first: '$$ROOT' } } },
  ]);

  const lastMessageByRoom = new Map(
    latestAgg.map((entry) => [entry._id.toString(), serializeMessage(entry.doc)])
  );

  // Unread count trade-off: running countDocuments per room leverages the { room: 1, createdAt: -1 }
  // index and is fast up to MAX_ROOMS_PER_USER (50). At larger scale (hundreds of rooms per user),
  // we would maintain a denormalized unread counter per (user, room) incremented on message:send.
  const unreadCounts = await Promise.all(
    rooms.map((room) => {
      const myMember = room.members.find(
        (m) => m.user && (m.user._id || m.user).toString() === userId.toString()
      );
      const since = myMember?.lastReadAt || myMember?.joinedAt || new Date(0);
      return Message.countDocuments({
        room: room._id,
        createdAt: { $gt: since },
        sender: { $ne: userObjectId },
      });
    })
  );

  const enriched = rooms.map((room, idx) =>
    serializeRoom(room, userId, {
      lastMessage: lastMessageByRoom.get(room._id.toString()) || null,
      unreadCount: unreadCounts[idx],
    })
  );

  enriched.sort((a, b) => {
    const timeA = new Date(a.lastMessage?.createdAt || a.updatedAt).getTime();
    const timeB = new Date(b.lastMessage?.createdAt || b.updatedAt).getTime();
    return timeB - timeA;
  });

  return enriched;
}

export async function getRoomMessages({
  roomId,
  userId,
  before,
  after,
  around,
  limit = 50,
  storageService = defaultStorageService,
}) {
  const { room } = await getRoomIfMember(roomId, userId);

  if (around) {
    const anchor = await Message.findOne({ _id: around, room: room._id }).lean();
    if (!anchor) {
      return { messages: [], hasMore: false, hasMoreOlder: false, hasMoreNewer: false };
    }

    const half = Math.floor((limit - 1) / 2);
    const [olderDocs, newerDocs] = await Promise.all([
      Message.find({
        room: room._id,
        _id: { $ne: anchor._id },
        createdAt: { $lte: anchor.createdAt },
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(half + 1)
        .lean(),
      Message.find({
        room: room._id,
        _id: { $ne: anchor._id },
        createdAt: { $gte: anchor.createdAt },
      })
        .sort({ createdAt: 1, _id: 1 })
        .limit(limit - 1 - half + 1)
        .lean(),
    ]);

    const hasMoreOlder = olderDocs.length > half;
    const olderPage = (hasMoreOlder ? olderDocs.slice(0, half) : olderDocs).reverse();

    const newerLimit = limit - 1 - half;
    const hasMoreNewer = newerDocs.length > newerLimit;
    const newerPage = hasMoreNewer ? newerDocs.slice(0, newerLimit) : newerDocs;

    // Deduplicate in case anchor and a neighbor share the exact same millisecond timestamp
    const seen = new Set();
    const combined = [];
    for (const d of [...olderPage, anchor, ...newerPage]) {
      const idStr = d._id.toString();
      if (!seen.has(idStr)) {
        seen.add(idStr);
        combined.push(d);
      }
    }

    const messages = await Promise.all(
      combined.map((d) => storageService.attachDownloadUrls(serializeMessage(d)))
    );

    return {
      messages,
      hasMore: hasMoreOlder,
      hasMoreOlder,
      hasMoreNewer,
      anchorId: anchor._id.toString(),
    };
  }

  if (after) {
    const docs = await Message.find({
      room: room._id,
      createdAt: { $gt: new Date(after) },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    const messages = await Promise.all(
      docs.map((d) => storageService.attachDownloadUrls(serializeMessage(d)))
    );

    return {
      messages,
      hasMore: false,
    };
  }

  const filter = { room: room._id };
  if (before) {
    filter.createdAt = { $lt: new Date(before) };
  }

  const docs = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  page.reverse();

  const messages = await Promise.all(
    page.map((d) => storageService.attachDownloadUrls(serializeMessage(d)))
  );

  return {
    messages,
    hasMore,
  };
}

/**
 * Fetches messages created, edited, or soft-deleted since a given updatedAt cursor
 * so reconnecting or room-switching clients pick up edits and deletes.
 */
export async function getRoomChanges({
  roomId,
  userId,
  since,
  storageService = defaultStorageService,
}) {
  const { room } = await getRoomIfMember(roomId, userId);

  const docs = await Message.find({
    room: room._id,
    updatedAt: { $gt: new Date(since) },
  })
    .sort({ updatedAt: 1 })
    .limit(200)
    .lean();

  const changes = await Promise.all(
    docs.map((d) => storageService.attachDownloadUrls(serializeMessage(d)))
  );

  return {
    changes,
  };
}
