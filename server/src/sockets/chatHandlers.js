import Message, { serializeMessage } from '../models/Message.js';
import { messageReadSchema, messageSendSchema } from '../utils/validators.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';

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
      const { room: generalRoom } = await ensureGeneralRoom();
      // Persist before broadcasting so every delivered message is guaranteed durable
      // and has a canonical MongoDB _id and createdAt timestamp.
      const doc = await Message.create({
        room: generalRoom._id,
        sender: userId,
        senderName: username,
        text,
      });

      const serialized = serializeMessage(doc);
      io.to(roomId).emit('message:new', serialized);

      return respond({ ok: true, id: serialized._id });
    } catch (err) {
      console.error('[socket] Failed to persist message:', err);
      return respond({ ok: false, error: 'Failed to send message' });
    }
  });

  socket.on('typing:start', (payload) => {
    const roomId = typeof payload?.roomId === 'string' && payload.roomId ? payload.roomId : 'global';
    socket.to(roomId).emit('typing:start', { userId, username });
  });

  socket.on('typing:stop', (payload) => {
    const roomId = typeof payload?.roomId === 'string' && payload.roomId ? payload.roomId : 'global';
    socket.to(roomId).emit('typing:stop', { userId, username });
  });

  socket.on('message:read', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const parsed = messageReadSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({ ok: false, error: 'Invalid read receipt payload' });
    }

    const { messageIds, roomId } = parsed.data;

    try {
      const { room: generalRoom } = await ensureGeneralRoom();
      await Message.updateMany(
        { _id: { $in: messageIds }, room: generalRoom._id, sender: { $ne: userId } },
        { $addToSet: { readBy: userId } }
      );

      io.to(roomId).emit('message:read', {
        messageIds,
        userId,
        username,
      });

      return respond({ ok: true });
    } catch (err) {
      console.error('[socket] Failed to update read receipts:', err);
      return respond({ ok: false, error: 'Failed to mark messages as read' });
    }
  });
}
