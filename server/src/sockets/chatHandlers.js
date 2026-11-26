import mongoose from 'mongoose';
import Message, { serializeMessage, serializeReactions } from '../models/Message.js';
import Room from '../models/Room.js';
import User from '../models/User.js';
import {
  messageDeleteSchema,
  messageEditSchema,
  messageReadSchema,
  messageSendSchema,
  objectIdSchema,
  reactionToggleSchema,
} from '../utils/validators.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';
import { getRoomIfMember } from '../services/roomAccess.js';
import { can } from '../services/permissions.js';
import { deliverMessage } from '../services/messageService.js';
import { defaultStorageService } from '../services/storage.js';
import { defaultFloodControl } from '../services/floodControl.js';
import { audit } from '../services/auditService.js';

const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 10;
const MAX_NEW_ACCOUNT_MESSAGES_PER_WINDOW = 3;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

function isSocketRateLimited(timestamps, now, maxMessages = MAX_MESSAGES_PER_WINDOW) {
  // Evict timestamps outside the sliding 10-second window.
  while (timestamps.length > 0 && now - timestamps[0] >= RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= maxMessages) {
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

export function registerChatHandlers(
  io,
  socket,
  presence,
  { storageService = defaultStorageService, floodControl = defaultFloodControl } = {}
) {
  const sendTimestamps = [];
  const { id: userId, username } = socket.data.user;

  socket.on('message:send', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};

    if (socket.data.userCreatedAt === undefined && mongoose.isValidObjectId(userId)) {
      const userDoc = await User.findById(userId, { createdAt: 1 }).lean();
      socket.data.userCreatedAt = userDoc?.createdAt ?? null;
    }
    const maxPerWindow = floodControl.isNewAccount(socket.data.userCreatedAt)
      ? MAX_NEW_ACCOUNT_MESSAGES_PER_WINDOW
      : MAX_MESSAGES_PER_WINDOW;

    if (isSocketRateLimited(sendTimestamps, Date.now(), maxPerWindow)) {
      return respond({ ok: false, error: 'Rate limit exceeded. Please slow down.' });
    }

    const parsed = messageSendSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid message payload',
      });
    }

    const { text, roomId, attachments, mentions } = parsed.data;

    try {
      const room = await resolveAuthorizedRoom(roomId, userId);
      const roomIdStr = room._id.toString();

      const spamCheck = floodControl.checkSpam({ userId, text });
      if (!spamCheck.ok) {
        return respond(spamCheck);
      }

      // Re-validate attachment keys so a user cannot reference objects from another room.
      const expectedPrefix = `quarantine/${roomIdStr}/`;
      for (const att of attachments) {
        if (!att.key.startsWith(expectedPrefix) || att.key.includes('..')) {
          return respond({ ok: false, error: 'Invalid attachment key for this room' });
        }
        await storageService.verifyUploadedObject({ key: att.key, expectedSize: att.size });
      }

      const result = await deliverMessage({
        room,
        userId,
        username,
        text,
        attachments,
        mentions,
        io,
        presence,
        storageService,
        floodControl,
      });

      return respond(result);
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
      if (!can(socket.data.user, 'message.edit_own', { room, message: msg })) {
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
      const { room } = await getRoomIfMember(roomId, userId);
      const msg = await Message.findOne({ _id: messageId, room: room._id });
      if (!msg) {
        return respond({ ok: false, error: 'Message not found' });
      }

      const isAuthor = msg.sender.toString() === userId;
      const deleteAction = isAuthor ? 'message.delete_own' : 'message.delete_any';
      if (!can(socket.data.user, deleteAction, { room, message: msg })) {
        return respond({ ok: false, error: 'Not authorized to delete this message' });
      }

      if (!msg.deletedAt) {
        // Soft-delete: clear text so deleted content is never retained or leaked,
        // while keeping the document for read receipts and unread counts.
        msg.text = '';
        msg.deletedAt = new Date();
        msg.deletedBy = userId;
        await msg.save();

        if (!isAuthor) {
          await audit('message.delete_moderator', {
            actor: userId,
            targetType: 'message',
            targetId: msg._id.toString(),
            ip: socket.data.clientIp,
            userAgent: socket.handshake?.headers?.['user-agent'],
            metadata: {
              roomId: room._id.toString(),
              originalSender: msg.sender.toString(),
            },
          });
        }
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

  socket.on('reaction:toggle', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};

    if (isSocketRateLimited(sendTimestamps, Date.now())) {
      return respond({ ok: false, error: 'Rate limit exceeded. Please slow down.' });
    }

    const parsed = reactionToggleSchema.safeParse(payload);
    if (!parsed.success) {
      return respond({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid reaction payload',
      });
    }

    const { roomId, messageId, emoji } = parsed.data;

    try {
      const { room } = await getRoomIfMember(roomId, userId);
      const msg = await Message.findOne(
        { _id: messageId, room: room._id },
        { deletedAt: 1, reactions: 1 }
      ).lean();

      if (!msg) {
        return respond({ ok: false, error: 'Message not found' });
      }
      if (msg.deletedAt) {
        return respond({ ok: false, error: 'Cannot react to a deleted message' });
      }

      const userObjectId = new mongoose.Types.ObjectId(userId);
      const existingEntry = (msg.reactions || []).find((r) => r.emoji === emoji);
      const hasReacted = Boolean(
        existingEntry?.users?.some((id) => id.toString() === userId)
      );

      // Atomic MongoDB array operators ($addToSet / $pull) execute under document-level
      // locking so concurrent reactions from two users never overwrite each other.
      if (hasReacted) {
        await Message.updateOne(
          { _id: messageId, room: room._id, 'reactions.emoji': emoji },
          { $pull: { 'reactions.$.users': userObjectId } }
        );
        await Message.updateOne(
          { _id: messageId, room: room._id },
          { $pull: { reactions: { users: { $size: 0 } } } }
        );
      } else {
        const addRes = await Message.updateOne(
          { _id: messageId, room: room._id, 'reactions.emoji': emoji },
          { $addToSet: { 'reactions.$.users': userObjectId } }
        );

        if (addRes.matchedCount === 0) {
          const pushRes = await Message.updateOne(
            { _id: messageId, room: room._id, 'reactions.emoji': { $ne: emoji } },
            { $push: { reactions: { emoji, users: [userObjectId] } } }
          );
          // If a concurrent request just inserted this emoji entry, add our user to it.
          if (pushRes.modifiedCount === 0) {
            await Message.updateOne(
              { _id: messageId, room: room._id, 'reactions.emoji': emoji },
              { $addToSet: { 'reactions.$.users': userObjectId } }
            );
          }
        }
      }

      const updated = await Message.findById(messageId, { reactions: 1 }).lean();
      const reactions = serializeReactions(updated?.reactions || []);

      io.to(`room:${room._id.toString()}`).emit('reaction:updated', {
        roomId: room._id.toString(),
        messageId,
        reactions,
      });

      return respond({ ok: true, reactions });
    } catch (err) {
      if (err.isOperational) {
        return respond({ ok: false, error: err.message });
      }
      console.error('[socket] Failed to toggle reaction:', err);
      return respond({ ok: false, error: 'Failed to toggle reaction' });
    }
  });

  socket.on('typing:start', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    if (payload?.roomId !== undefined && !objectIdSchema.safeParse(payload.roomId).success) {
      return respond({ ok: false, error: 'Invalid room ID' });
    }
    try {
      const room = await resolveAuthorizedRoom(payload?.roomId, userId);
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
            return respond({ ok: true });
          }
        }
      }
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

      if (!can(socket.data.user, 'message.send', { room })) {
        return respond({ ok: false, error: 'You do not have permission to send messages here' });
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
            return respond({ ok: false, error: 'You cannot message this user' });
          }
        }
      }

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
