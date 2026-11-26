import { Router } from 'express';
import mongoose from 'mongoose';
import Room, { makeDmKey } from '../models/Room.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  createDmSchema,
  createRoomSchema,
  inviteMembersSchema,
  messagesQuerySchema,
  publicRoomsQuerySchema,
} from '../utils/validators.js';
import { assertRoomOwner, getRoomIfMember, parseRoomId } from '../services/roomAccess.js';
import {
  getRoomMessages,
  getRoomsWithPreviews,
  MAX_MEMBERS_PER_ROOM,
  MAX_ROOMS_PER_USER,
  serializeRoom,
} from '../services/roomService.js';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRoomsRouter({ rateLimiter } = {}) {
  const router = Router();

  router.use(requireAuth);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  // GET /api/rooms — my rooms (all types), with lastMessage, unreadCount, and DM otherUser
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const rooms = await getRoomsWithPreviews(req.user.id);
      res.status(200).json({ rooms });
    })
  );

  // GET /api/rooms/public — discoverable public rooms I haven't joined
  router.get(
    '/public',
    asyncHandler(async (req, res) => {
      const parsed = publicRoomsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid query parameters', 400);
      }

      const { q, page, limit } = parsed.data;
      const userObjectId = new mongoose.Types.ObjectId(req.user.id);
      const filter = {
        type: 'public',
        'members.user': { $ne: userObjectId },
      };

      if (q) {
        filter.nameLower = { $regex: escapeRegex(q.toLowerCase()) };
      }

      const skip = (page - 1) * limit;
      const [docs, total] = await Promise.all([
        Room.find(filter)
          .sort({ nameLower: 1 })
          .skip(skip)
          .limit(limit)
          .populate('members.user', 'username')
          .lean(),
        Room.countDocuments(filter),
      ]);

      res.status(200).json({
        rooms: docs.map((doc) => serializeRoom(doc, req.user.id)),
        page,
        limit,
        total,
        hasMore: skip + docs.length < total,
      });
    })
  );

  // POST /api/rooms — create public or private room
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = createRoomSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid room data', 400);
      }

      const { name, type, memberIds } = parsed.data;
      const userId = req.user.id;

      const myRoomCount = await Room.countDocuments({ 'members.user': userId });
      if (myRoomCount >= MAX_ROOMS_PER_USER) {
        throw new AppError(`Room limit reached (max ${MAX_ROOMS_PER_USER} rooms per user)`, 400);
      }

      const nameLower = name.toLowerCase();
      if (type === 'public') {
        const existing = await Room.findOne({ type: 'public', nameLower }).lean();
        if (existing) {
          throw new AppError('A public room with that name already exists', 409);
        }
      }

      const uniqueInviteeIds = [...new Set(memberIds)].filter((id) => id !== userId);
      if (uniqueInviteeIds.length + 1 > MAX_MEMBERS_PER_ROOM) {
        throw new AppError(`A room cannot exceed ${MAX_MEMBERS_PER_ROOM} members`, 400);
      }

      if (uniqueInviteeIds.length > 0) {
        const validUsersCount = await User.countDocuments({ _id: { $in: uniqueInviteeIds } });
        if (validUsersCount !== uniqueInviteeIds.length) {
          throw new AppError('One or more invited users do not exist', 400);
        }
      }

      const now = new Date();
      const members = [
        { user: userId, role: 'owner', joinedAt: now, lastReadAt: now },
        ...uniqueInviteeIds.map((id) => ({
          user: id,
          role: 'member',
          joinedAt: now,
          lastReadAt: now,
        })),
      ];

      const created = await Room.create({
        name,
        type,
        createdBy: userId,
        members,
      });

      const populated = await Room.findById(created._id)
        .populate('members.user', 'username')
        .lean();

      res.status(201).json({ room: serializeRoom(populated, userId) });
    })
  );

  // POST /api/rooms/dm — find-or-create 1-to-1 DM
  router.post(
    '/dm',
    asyncHandler(async (req, res) => {
      const parsed = createDmSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid user ID', 400);
      }

      const targetUserId = parsed.data.userId;
      const myUserId = req.user.id;

      if (targetUserId === myUserId) {
        throw new AppError('Cannot start a direct message with yourself', 400);
      }

      const targetUser = await User.findById(targetUserId, { _id: 1 }).lean();
      if (!targetUser) {
        throw new AppError('User not found', 404);
      }

      const dmKey = makeDmKey(myUserId, targetUserId);
      let existing = await Room.findOne({ type: 'dm', dmKey })
        .populate('members.user', 'username')
        .lean();

      if (existing) {
        return res.status(200).json({ room: serializeRoom(existing, myUserId), created: false });
      }

      const myRoomCount = await Room.countDocuments({ 'members.user': myUserId });
      if (myRoomCount >= MAX_ROOMS_PER_USER) {
        throw new AppError(`Room limit reached (max ${MAX_ROOMS_PER_USER} rooms per user)`, 400);
      }

      const now = new Date();
      try {
        const created = await Room.create({
          type: 'dm',
          dmKey,
          createdBy: myUserId,
          members: [
            { user: myUserId, role: 'member', joinedAt: now, lastReadAt: now },
            { user: targetUserId, role: 'member', joinedAt: now, lastReadAt: now },
          ],
        });
        const populated = await Room.findById(created._id)
          .populate('members.user', 'username')
          .lean();
        return res.status(201).json({ room: serializeRoom(populated, myUserId), created: true });
      } catch (err) {
        if (err.code === 11000) {
          existing = await Room.findOne({ type: 'dm', dmKey })
            .populate('members.user', 'username')
            .lean();
          if (existing) {
            return res
              .status(200)
              .json({ room: serializeRoom(existing, myUserId), created: false });
          }
        }
        throw err;
      }
    })
  );

  // POST /api/rooms/:id/join — join a public room
  router.post(
    '/:id/join',
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      const room = await Room.findById(roomId);

      // Return 404 for private/DM rooms so non-members cannot discover their existence.
      if (!room || room.type !== 'public') {
        throw new AppError('Room not found', 404);
      }

      const userId = req.user.id;
      const alreadyMember = room.members.some((m) => m.user.toString() === userId);

      if (!alreadyMember) {
        if (room.members.length >= MAX_MEMBERS_PER_ROOM) {
          throw new AppError(`Room has reached the ${MAX_MEMBERS_PER_ROOM} member limit`, 400);
        }
        const myRoomCount = await Room.countDocuments({ 'members.user': userId });
        if (myRoomCount >= MAX_ROOMS_PER_USER) {
          throw new AppError(`Room limit reached (max ${MAX_ROOMS_PER_USER} rooms per user)`, 400);
        }

        const now = new Date();
        room.members.push({ user: userId, role: 'member', joinedAt: now, lastReadAt: now });
        await room.save();
      }

      const populated = await Room.findById(room._id)
        .populate('members.user', 'username')
        .lean();
      res.status(200).json({ room: serializeRoom(populated, userId) });
    })
  );

  // POST /api/rooms/:id/members — invite users to a private room (owner only)
  router.post(
    '/:id/members',
    asyncHandler(async (req, res) => {
      const parsed = inviteMembersSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid member list', 400);
      }

      const { room } = await assertRoomOwner(req.params.id, req.user.id);
      if (room.type !== 'private') {
        throw new AppError('Only private rooms support owner invitations', 400);
      }

      const existingIds = new Set(room.members.map((m) => m.user.toString()));
      const newIds = [...new Set(parsed.data.memberIds)].filter((id) => !existingIds.has(id));

      if (newIds.length > 0) {
        if (room.members.length + newIds.length > MAX_MEMBERS_PER_ROOM) {
          throw new AppError(`Room cannot exceed ${MAX_MEMBERS_PER_ROOM} members`, 400);
        }

        const validUsersCount = await User.countDocuments({ _id: { $in: newIds } });
        if (validUsersCount !== newIds.length) {
          throw new AppError('One or more invited users do not exist', 400);
        }

        const now = new Date();
        for (const id of newIds) {
          room.members.push({ user: id, role: 'member', joinedAt: now, lastReadAt: now });
        }
        await room.save();
      }

      const populated = await Room.findById(room._id)
        .populate('members.user', 'username')
        .lean();
      res.status(200).json({
        room: serializeRoom(populated, req.user.id),
        addedMemberIds: newIds,
      });
    })
  );

  // DELETE /api/rooms/:id/members/me — leave a room
  router.delete(
    '/:id/members/me',
    asyncHandler(async (req, res) => {
      const { room, member } = await getRoomIfMember(req.params.id, req.user.id);

      if (room.type === 'dm') {
        throw new AppError('Direct messages cannot be left', 400);
      }
      if (member.role === 'owner') {
        throw new AppError('Room owner must transfer ownership or delete the room first', 400);
      }

      await Room.updateOne(
        { _id: room._id },
        { $pull: { members: { user: req.user.id } } }
      );

      res.status(200).json({ ok: true, roomId: room._id.toString() });
    })
  );

  // DELETE /api/rooms/:id — delete a room (owner only, cannot delete General or DMs)
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { room } = await assertRoomOwner(req.params.id, req.user.id);
      if (room.type === 'dm' || room.nameLower === 'general') {
        throw new AppError('This room cannot be deleted', 400);
      }

      await Promise.all([
        Message.deleteMany({ room: room._id }),
        Room.deleteOne({ _id: room._id }),
      ]);

      res.status(200).json({ ok: true, roomId: room._id.toString() });
    })
  );

  // GET /api/rooms/:id/messages — cursor-paginated history, membership required
  router.get(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const parsed = messagesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid query parameters', 400);
      }

      const { before, after, limit } = parsed.data;
      const result = await getRoomMessages({
        roomId: req.params.id,
        userId: req.user.id,
        before,
        after,
        limit,
      });

      res.status(200).json(result);
    })
  );

  return router;
}
