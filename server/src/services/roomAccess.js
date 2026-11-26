import Room from '../models/Room.js';
import { AppError } from '../middleware/errorHandler.js';
import { objectIdSchema } from '../utils/validators.js';

/**
 * Validates a roomId string with Zod + mongoose.isValidObjectId before any DB query.
 */
export function parseRoomId(roomId) {
  const parsed = objectIdSchema.safeParse(roomId);
  if (!parsed.success) {
    throw new AppError('Invalid room ID', 400);
  }
  return parsed.data;
}

/**
 * Single authorization gate for all room-scoped REST routes and socket handlers.
 * Returns { room, member } if the user belongs to the room (and is owner when required).
 * Returns 404 for private/DM non-members so room existence is never leaked via IDOR.
 */
export async function getRoomIfMember(roomId, userId, { requireOwner = false } = {}) {
  const validId = parseRoomId(roomId);
  const room = await Room.findById(validId);

  if (!room) {
    throw new AppError('Room not found', 404);
  }

  const userIdStr = userId.toString();
  const member = room.members.find((m) => m.user.toString() === userIdStr);

  if (!member) {
    if (room.type === 'private' || room.type === 'dm') {
      throw new AppError('Room not found', 404);
    }
    throw new AppError('You are not a member of this room', 403);
  }

  if (requireOwner && member.role !== 'owner') {
    throw new AppError('Only the room owner can perform this action', 403);
  }

  return { room, member };
}

export async function assertRoomOwner(roomId, userId) {
  return getRoomIfMember(roomId, userId, { requireOwner: true });
}
