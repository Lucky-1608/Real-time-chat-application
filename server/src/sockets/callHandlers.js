import { z } from 'zod';
import { getRoomIfMember } from '../services/roomAccess.js';
import { isFeatureEnabled } from '../services/featureFlags.js';
import { objectIdSchema } from '../utils/validators.js';

const MAX_CALL_PARTICIPANTS = 12;

const callJoinSchema = z.object({
  roomId: objectIdSchema,
  video: z.boolean().optional().default(false),
});

const callSignalSchema = z.object({
  roomId: objectIdSchema,
  targetUserId: objectIdSchema,
  sdp: z
    .object({
      type: z.enum(['offer', 'answer']),
      sdp: z.string().min(1).max(32_000),
    })
    .optional(),
  candidate: z
    .object({
      candidate: z.string().max(4096),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
    })
    .optional(),
});

export function registerCallHandlers(io, socket, callRooms) {
  const { id: userId, username } = socket.data.user;

  async function verifyMembership(roomId) {
    if (!(await isFeatureEnabled('calls'))) {
      throw new Error('Calls feature is currently disabled');
    }
    const { room } = await getRoomIfMember(roomId, userId, {
      workspaceId: socket.data.activeWorkspaceId || null,
    });
    return room;
  }

  socket.on('call:join', async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const parsed = callJoinSchema.safeParse(payload || {});
    if (!parsed.success) {
      return respond({ ok: false, error: 'Invalid call:join payload' });
    }

    try {
      const room = await verifyMembership(parsed.data.roomId);
      const roomIdStr = room._id.toString();

      let participants = callRooms.get(roomIdStr);
      if (!participants) {
        participants = new Map();
        callRooms.set(roomIdStr, participants);
      }

      if (!participants.has(userId) && participants.size >= MAX_CALL_PARTICIPANTS) {
        return respond({ ok: false, error: `Call is full (max ${MAX_CALL_PARTICIPANTS})` });
      }

      participants.set(userId, { userId, username, video: parsed.data.video });
      socket.to(`room:${roomIdStr}`).emit('call:participant_joined', {
        roomId: roomIdStr,
        userId,
        username,
        video: parsed.data.video,
      });

      return respond({
        ok: true,
        participants: Array.from(participants.values()),
      });
    } catch (err) {
      return respond({ ok: false, error: err.message || 'Failed to join call' });
    }
  });

  socket.on('call:leave', (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const roomIdStr = String(payload?.roomId || '');
    const participants = callRooms.get(roomIdStr);
    if (participants?.delete(userId)) {
      if (participants.size === 0) callRooms.delete(roomIdStr);
      socket.to(`room:${roomIdStr}`).emit('call:participant_left', { roomId: roomIdStr, userId });
    }
    return respond({ ok: true });
  });

  async function relaySignal(eventName, payload, ack) {
    const respond = typeof ack === 'function' ? ack : () => {};
    const parsed = callSignalSchema.safeParse(payload || {});
    if (!parsed.success) {
      return respond({ ok: false, error: `Invalid ${eventName} payload` });
    }

    const { roomId, targetUserId, sdp, candidate } = parsed.data;
    try {
      const room = await verifyMembership(roomId);
      const isTargetMember = (room.members || []).some(
        (m) => m.user.toString() === targetUserId
      );
      if (!isTargetMember) {
        return respond({ ok: false, error: 'Target user is not a member of this room' });
      }

      io.to(`user:${targetUserId}`).emit(eventName, {
        roomId,
        fromUserId: userId,
        fromUsername: username,
        ...(sdp ? { sdp } : {}),
        ...(candidate ? { candidate } : {}),
      });
      return respond({ ok: true });
    } catch (err) {
      return respond({ ok: false, error: err.message || `Failed to relay ${eventName}` });
    }
  }

  socket.on('call:offer', (payload, ack) => relaySignal('call:offer', payload, ack));
  socket.on('call:answer', (payload, ack) => relaySignal('call:answer', payload, ack));
  socket.on('call:ice', (payload, ack) => relaySignal('call:ice', payload, ack));

  socket.on('disconnect', () => {
    for (const [roomIdStr, participants] of callRooms.entries()) {
      if (participants.delete(userId)) {
        if (participants.size === 0) callRooms.delete(roomIdStr);
        socket.to(`room:${roomIdStr}`).emit('call:participant_left', { roomId: roomIdStr, userId });
      }
    }
  });
}
