import Message, { serializeMessage } from '../models/Message.js';
import { messageReadSchema, messageSendSchema, objectIdSchema } from '../utils/validators.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';
import { getRoomIfMember } from '../services/roomAccess.js';

const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 10;

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

export function registerChatHandlers(io, socket) {
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

      // Persist before broadcasting so every delivered message is guaranteed durable
      // and has a canonical MongoDB _id and createdAt timestamp.
      const doc = await Message.create({
        room: room._id,
        sender: userId,
        senderName: username,
        text,
      });

      const serialized = serializeMessage(doc);
      // Use room:global channel until Sub-phase 6.4 migrates sockets to room:<id>.
      io.to('global').emit('message:new', serialized);

      return respond({ ok: true, id: serialized._id });
    } catch (err) {
      if (err.isOperational) {
        return respond({ ok: false, error: err.message });
      }
      console.error('[socket] Failed to persist message:', err);
      return respond({ ok: false, error: 'Failed to send message' });
    }
  });

  socket.on('typing:start', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    if (payload?.roomId !== undefined && !objectIdSchema.safeParse(payload.roomId).success) {
      return respond({ ok: false, error: 'Invalid room ID' });
    }
    try {
      await resolveAuthorizedRoom(payload?.roomId, userId);
      socket.to('global').emit('typing:start', { userId, username });
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
      await resolveAuthorizedRoom(payload?.roomId, userId);
      socket.to('global').emit('typing:stop', { userId, username });
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
      await Message.updateMany(
        { _id: { $in: messageIds }, room: room._id, sender: { $ne: userId } },
        { $addToSet: { readBy: userId } }
      );

      io.to('global').emit('message:read', {
        messageIds,
        userId,
        username,
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
}
