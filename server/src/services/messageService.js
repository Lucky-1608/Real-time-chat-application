import Message, { serializeMessage } from '../models/Message.js';
import User from '../models/User.js';
import Draft from '../models/Draft.js';
import { can } from './permissions.js';
import { defaultStorageService } from './storage.js';
import { defaultFloodControl } from './floodControl.js';

/**
 * Shared message delivery path used by both real-time socket message:send
 * and the scheduled-message worker so permissions, slow mode, disappearing TTL,
 * draft clearing, and unread notifications stay identical.
 */
export async function deliverMessage({
  room,
  userId,
  username,
  text,
  attachments = [],
  mentions = [],
  scheduledKey = undefined,
  io = null,
  presence = null,
  storageService = defaultStorageService,
  floodControl = defaultFloodControl,
}) {
  const roomIdStr = room._id.toString();

  if (!can({ id: userId }, 'message.send', { room })) {
    return { ok: false, error: 'You do not have permission to send messages here' };
  }

  // Validate structured @mentions against current room membership
  const uniqueMentions = [...new Set(mentions)];
  if (uniqueMentions.length > 0) {
    const memberIds = new Set((room.members || []).map((m) => m.user.toString()));
    for (const mid of uniqueMentions) {
      if (!memberIds.has(mid)) {
        return { ok: false, error: 'Cannot mention a user who is not a member of this room' };
      }
    }
  }

  if (room.type === 'dm') {
    const other = room.members.find((m) => m.user.toString() !== userId);
    if (other) {
      const [senderDoc, otherDoc] = await Promise.all([
        User.findById(userId, { blockedUsers: 1 }).lean(),
        User.findById(other.user, { blockedUsers: 1 }).lean(),
      ]);
      const blocked =
        (senderDoc?.blockedUsers || []).some((id) => id.toString() === other.user.toString()) ||
        (otherDoc?.blockedUsers || []).some((id) => id.toString() === userId);
      if (blocked) {
        return { ok: false, error: 'You cannot message this user' };
      }
    }
  }

  const slowCheck = floodControl.checkSlowMode({
    roomId: roomIdStr,
    userId,
    slowModeSeconds: room.slowModeSeconds || 0,
  });
  if (!slowCheck.ok) {
    return slowCheck;
  }

  const expiresAt =
    room.disappearingTtlSeconds > 0
      ? new Date(Date.now() + room.disappearingTtlSeconds * 1000)
      : null;

  let doc;
  try {
    doc = await Message.create({
      workspace: room.workspace,
      room: room._id,
      sender: userId,
      senderName: username,
      text,
      mentions: uniqueMentions,
      attachments: attachments.map((att) => ({ ...att, scanStatus: 'pending' })),
      expiresAt,
      ...(scheduledKey ? { scheduledKey } : {}),
    });
  } catch (err) {
    // Idempotency guard: if a scheduled message was already inserted by another worker,
    // return the existing message without broadcasting a duplicate.
    if (err.code === 11000 && scheduledKey) {
      const existing = await Message.findOne({ workspace: room.workspace, scheduledKey }).lean();
      if (existing) {
        return { ok: true, id: existing._id.toString(), duplicate: true };
      }
    }
    throw err;
  }

  const serialized = await storageService.attachDownloadUrls(serializeMessage(doc));
  if (io) {
    io.to(`room:${roomIdStr}`).emit('message:new', serialized);
    await Draft.deleteOne({ user: userId, room: room._id }).catch(() => {});
    io.to(`user:${userId}`).emit('draft:updated', { roomId: roomIdStr, text: '' });

    if (presence) {
      const onlineRecipients = room.members.filter(
        (m) =>
          !m.muted &&
          m.notificationLevel !== 'muted' &&
          m.user.toString() !== userId &&
          presence.isUserOnline(m.user)
      );
      if (onlineRecipients.length > 0) {
        const recipientDocs = await User.find(
          { _id: { $in: onlineRecipients.map((m) => m.user) } },
          { username: 1, mutedUsers: 1, blockedUsers: 1, globalMute: 1, dnd: 1 }
        ).lean();
        const docById = new Map(recipientDocs.map((u) => [u._id.toString(), u]));

        const eligible = onlineRecipients.filter((m) => {
          const u = docById.get(m.user.toString());
          if (!u) return false;
          if (u.globalMute) return false;
          if (u.dnd?.enabled && (!u.dnd.until || new Date(u.dnd.until) > new Date())) {
            return false;
          }
          if (
            (u.mutedUsers || []).some((id) => id.toString() === userId) ||
            (u.blockedUsers || []).some((id) => id.toString() === userId)
          ) {
            return false;
          }
          if (m.notificationLevel === 'mentions') {
            if (uniqueMentions.includes(m.user.toString())) return true;
            const mentionPattern = new RegExp(`@${u.username}\\b`, 'i');
            return mentionPattern.test(text || '');
          }
          return true;
        });

        await Promise.all(
          eligible.map(async (member) => {
            const since = member.lastReadAt || member.joinedAt || new Date(0);
            const unreadCount = await Message.countDocuments({
              workspace: room.workspace,
              room: room._id,
              createdAt: { $gt: since },
              sender: { $ne: member.user },
            });
            io.to(`user:${member.user.toString()}`).emit('room:unread', {
              roomId: roomIdStr,
              unreadCount,
            });
          })
        );
      }
    }
  }

  return { ok: true, id: serialized._id };
}
