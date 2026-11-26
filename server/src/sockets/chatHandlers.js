import Message, { serializeMessage } from '../models/Message.js';
import Room from '../models/Room.js';
import {
  messageDeleteSchema,
  messageEditSchema,
  messageReadSchema,
  messageSendSchema,
  objectIdSchema,
} from '../utils/validators.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';
import { getRoomIfMember } from '../services/roomAccess.js';

const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 10;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

function isSocketRateLimited(timestamps, now) {
  // Evict timestamps outside the sliding 10-second window.
  while (timestamps.length > 0 && now - timestamps[0] >= RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= MAX_MESSAGES_PER_WINDOW) {
    return true;
  }
  timestamps.push(now);
  return false;
}

async function resolveAuthorizedRoom(roomId, userId) {
  const targetRoomId = roomId || (await ensureGeneralRoom()).room._id.toString();
  const { room } = await getRoomIfMember(targetRoomId, userId);
  return room;
}

export function registerChatHandlers(io, socket, presence) {
  const sendTimestamps = [];
  const { id: userId, username } = socket.data.user;

  socket.on('message:send', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};

    if (isSocketRateLimited(sendTimestamps, Date.now())) {
      return respond({ ok: false, error: 'Rate limit exceeded. Please slow down.' });
    }

    const parsed = messageSendSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid message payload',
      });
    }

    const { text, roomId } = parsed.data;

    try {
      const room = await resolveAuthorizedRoom(roomId, userId);
      const roomIdStr = room._id.toString();

      // Persist before broadcasting so every delivered message is guaranteed durable
      // and has a canonical MongoDB _id and createdAt timestamp.
      const doc = await Message.create({
        room: room._id,
        sender: userId,
        senderName: username,
        text,
      });

      const serialized = serializeMessage(doc);
      io.to(`room:${roomIdStr}`).emit('message:new', serialized);

      // Notify online room members on their personal channel so sidebars update unread badges.
      if (presence) {
        const onlineRecipients = room.members.filter(
          (m) => m.user.toString() !== userId && presence.isUserOnline(m.user)
        );
        await Promise.all(
          onlineRecipients.map(async (member) => {
            const since = member.lastReadAt || member.joinedAt || new Date(0);
            const unreadCount = await Message.countDocuments({
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

      return respond({ ok: true, id: serialized._id });
    } catch (err) {
      if (err.isOperational) {
        return respond({ ok: false, error: err.message });
      }
      console.error('[socket] Failed to persist message:', err);
      return respond({ ok: false, error: 'Failed to send message' });
    }
  });

  socket.on('message:edit', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};

    if (isSocketRateLimited(sendTimestamps, Date.now())) {
      return respond({ ok: false, error: 'Rate limit exceeded. Please slow down.' });
    }

    const parsed = messageEditSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid edit payload',
      });
    }

    const { roomId, messageId, text } = parsed.data;

    try {
      const { room } = await getRoomIfMember(roomId, userId);
      // Match both _id and room so a user cannot edit a message in another room via roomId mismatch.
      const msg = await Message.findOne({ _id: messageId, room: room._id });
      if (!msg) {
        return respond({ ok: false, error: 'Message not found' });
      }
      if (msg.deletedAt) {
        return respond({ ok: false, error: 'Deleted messages cannot be edited' });
      }
      if (msg.sender.toString() !== userId) {
        return respond({ ok: false, error: 'Only the author can edit this message' });
      }
      if (Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS) {
        return respond({ ok: false, error: 'Edit window has expired' });
      }

      msg.text = text;
      msg.editedAt = new Date();
      await msg.save();

      const serialized = serializeMessage(msg);
      io.to(`room:${room._id.toString()}`).emit('message:updated', serialized);
      return respond({ ok: true });
    } catch (err) {
      if (err.isOperational) {
        return respond({ ok: false, error: err.message });
      }
      console.error('[socket] Failed to edit message:', err);
      return respond({ ok: false, error: 'Failed to edit message' });
    }
  });

  socket.on('message:delete', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};

    if (isSocketRateLimited(sendTimestamps, Date.now())) {
      return respond({ ok: false, error: 'Rate limit exceeded. Please slow down.' });
    }

    const parsed = messageDeleteSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid delete payload',
      });
    }

    const { roomId, messageId } = parsed.data;

    try {
      const { room, member } = await getRoomIfMember(roomId, userId);
      const msg = await Message.findOne({ _id: messageId, room: room._id });
      if (!msg) {
        return respond({ ok: false, error: 'Message not found' });
      }

      const isAuthor = msg.sender.toString() === userId;
      const isOwner = member.role === 'owner';
      if (!isAuthor && !isOwner) {
        return respond({ ok: false, error: 'Not authorized to delete this message' });
      }

      if (!msg.deletedAt) {
        // Soft-delete: clear text so deleted content is never retained or leaked,
        // while keeping the document for read receipts and unread counts.
        msg.text = '';
        msg.deletedAt = new Date();
        msg.deletedBy = userId;
        await msg.save();
      }

      io.to(`room:${room._id.toString()}`).emit('message:deleted', {
        roomId: room._id.toString(),
        messageId: msg._id.toString(),
        deletedAt: msg.deletedAt.toISOString(),
      });

      return respond({ ok: true });
    } catch (err) {
      if (err.isOperational) {
        return respond({ ok: false, error: err.message });
      }
      console.error('[socket] Failed to delete message:', err);
      return respond({ ok: false, error: 'Failed to delete message' });
    }
  });

  socket.on('typing:start', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    if (payload?.roomId !== undefined && !objectIdSchema.safeParse(payload.roomId).success) {
      return respond({ ok: false, error: 'Invalid room ID' });
    }
    try {
      const room = await resolveAuthorizedRoom(payload?.roomId, userId);
      const roomIdStr = room._id.toString();
      socket.to(`room:${roomIdStr}`).emit('typing:start', { roomId: roomIdStr, userId, username });
      return respond({ ok: true });
    } catch (err) {
      return respond({ ok: false, error: err.isOperational ? err.message : 'Unauthorized' });
    }
  });

  socket.on('typing:stop', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    if (payload?.roomId !== undefined && !objectIdSchema.safeParse(payload.roomId).success) {
      return respond({ ok: false, error: 'Invalid room ID' });
    }
    try {
      const room = await resolveAuthorizedRoom(payload?.roomId, userId);
      const roomIdStr = room._id.toString();
      socket.to(`room:${roomIdStr}`).emit('typing:stop', { roomId: roomIdStr, userId, username });
      return respond({ ok: true });
    } catch (err) {
      return respond({ ok: false, error: err.isOperational ? err.message : 'Unauthorized' });
    }
  });

  socket.on('message:read', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const parsed = messageReadSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({ ok: false, error: 'Invalid read receipt payload' });
    }

    const { messageIds, roomId } = parsed.data;

    try {
      const room = await resolveAuthorizedRoom(roomId, userId);
      const roomIdStr = room._id.toString();

      await Promise.all([
        Message.updateMany(
          { _id: { $in: messageIds }, room: room._id, sender: { $ne: userId } },
          { $addToSet: { readBy: userId } }
        ),
        Room.updateOne(
          { _id: room._id, 'members.user': userId },
          { $set: { 'members.$.lastReadAt': new Date() } }
        ),
      ]);

      io.to(`room:${roomIdStr}`).emit('message:read', {
        roomId: roomIdStr,
        messageIds,
        userId,
        username,
      });

      // Keep all open tabs of this user in sync with unreadCount: 0.
      io.to(`user:${userId}`).emit('room:unread', {
        roomId: roomIdStr,
        unreadCount: 0,
      });

      return respond({ ok: true });
    } catch (err) {
      if (err.isOperational) {
        return respond({ ok: false, error: err.message });
      }
      console.error('[socket] Failed to update read receipts:', err);
      return respond({ ok: false, error: 'Failed to mark messages as read' });
    }
  });

  // Allows clients to re-verify and re-join a room channel after reconnects.
  socket.on('room:subscribe', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    try {
      const room = await resolveAuthorizedRoom(payload?.roomId, userId);
      const roomIdStr = room._id.toString();
      socket.join(`room:${roomIdStr}`);
      return respond({ ok: true, roomId: roomIdStr });
    } catch (err) {
      return respond({ ok: false, error: err.isOperational ? err.message : 'Unauthorized' });
    }
  });
}
