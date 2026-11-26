import crypto from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import Room, { makeDmKey } from '../models/Room.js';
import User from '../models/User.js';
import Message, { serializeMessage } from '../models/Message.js';
import InviteLink from '../models/InviteLink.js';
import Draft from '../models/Draft.js';
import ScheduledMessage from '../models/ScheduledMessage.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  changeMemberRoleSchema,
  createDmSchema,
  createInviteSchema,
  createPollSchema,
  createRoomSchema,
  draftSchema,
  inviteMembersSchema,
  messagesQuerySchema,
  notificationLevelSchema,
  publicRoomsQuerySchema,
  roomChangesQuerySchema,
  roomMuteSchema,
  roomSummarySchema,
  scheduleMessageSchema,
  updateRoomSchema,
} from '../utils/validators.js';
import { getRoomIfMember, parseRoomId } from '../services/roomAccess.js';
import { assertCan } from '../services/permissions.js';
import { requireFeature } from '../services/featureFlags.js';
import { audit } from '../services/auditService.js';
import {
  getRoomChanges,
  getRoomMessages,
  getRoomsWithPreviews,
  MAX_MEMBERS_PER_ROOM,
  MAX_ROOMS_PER_USER,
  serializeRoom,
} from '../services/roomService.js';
import { defaultSummaryService } from '../services/summaryService.js';
import { defaultFloodControl } from '../services/floodControl.js';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRoomsRouter({
  rateLimiter,
  summaryRateLimiter,
  storageService,
  summaryService = defaultSummaryService,
  floodControl = defaultFloodControl,
} = {}) {
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

      const io = req.app.locals.io;
      if (io) {
        const roomIdStr = created._id.toString();
        for (const m of populated.members) {
          const memberId = m.user._id.toString();
          io.in(`user:${memberId}`).socketsJoin(`room:${roomIdStr}`);
          io.to(`user:${memberId}`).emit('room:created', {
            room: serializeRoom(populated, memberId),
          });
        }
      }

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

      const targetUser = await User.findById(targetUserId, { _id: 1, blockedUsers: 1 }).lean();
      if (!targetUser) {
        throw new AppError('User not found', 404);
      }

      const myUser = await User.findById(myUserId, { createdAt: 1, blockedUsers: 1 }).lean();
      const targetBlockedMe = (targetUser.blockedUsers || []).some(
        (id) => id.toString() === myUserId
      );
      const iBlockedTarget = (myUser?.blockedUsers || []).some(
        (id) => id.toString() === targetUserId
      );
      if (targetBlockedMe || iBlockedTarget) {
        throw new AppError('Cannot start a direct message with this user', 403);
      }

      const dmKey = makeDmKey(myUserId, targetUserId);
      let existing = await Room.findOne({ type: 'dm', dmKey })
        .populate('members.user', 'username')
        .lean();

      if (existing) {
        return res.status(200).json({ room: serializeRoom(existing, myUserId), created: false });
      }

      floodControl.assertNewAccountAllowed(myUser?.createdAt, 'starting direct messages');

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

        const io = req.app.locals.io;
        if (io) {
          const roomIdStr = created._id.toString();
          for (const memberId of [myUserId, targetUserId]) {
            io.in(`user:${memberId}`).socketsJoin(`room:${roomIdStr}`);
            io.to(`user:${memberId}`).emit('room:created', {
              room: serializeRoom(populated, memberId),
            });
          }
        }

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
      if ((room.bannedUsers || []).some((b) => b.user.toString() === userId)) {
        throw new AppError('You are banned from this room', 403);
      }

      const alreadyMember = room.members.some((m) => m.user.toString() === userId);

      if (!alreadyMember) {
        const myRoomCount = await Room.countDocuments({ 'members.user': userId });
        if (myRoomCount >= MAX_ROOMS_PER_USER) {
          throw new AppError(`Room limit reached (max ${MAX_ROOMS_PER_USER} rooms per user)`, 400);
        }

        const now = new Date();
        const updated = await Room.findOneAndUpdate(
          {
            _id: room._id,
            'members.user': { $ne: userId },
            $expr: {
              $lt: [{ $size: '$members' }, { $ifNull: ['$maxMembers', MAX_MEMBERS_PER_ROOM] }],
            },
          },
          {
            $push: {
              members: { user: userId, role: 'member', joinedAt: now, lastReadAt: now },
            },
          },
          { new: true }
        );
        if (!updated) {
          throw new AppError('Room has reached its member limit', 400);
        }
      }

      const populated = await Room.findById(room._id)
        .populate('members.user', 'username')
        .lean();

      const serialized = serializeRoom(populated, userId);
      const io = req.app.locals.io;
      if (io && !alreadyMember) {
        const roomIdStr = room._id.toString();
        io.in(`user:${userId}`).socketsJoin(`room:${roomIdStr}`);
        io.to(`user:${userId}`).emit('room:joined', { room: serialized });
        io.to(`room:${roomIdStr}`).emit('room:joined', {
          roomId: roomIdStr,
          user: { id: userId, username: req.user.username },
        });
      }

      res.status(200).json({ room: serialized });
    })
  );

  // POST /api/rooms/:id/members — invite users to a private room (owner/admin/moderator)
  router.post(
    '/:id/members',
    asyncHandler(async (req, res) => {
      const parsed = inviteMembersSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid member list', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      if (room.type !== 'private') {
        throw new AppError('Only private rooms support invitations', 400);
      }
      assertCan(
        req.user,
        'member.invite',
        { room },
        'You do not have permission to invite members to this room'
      );

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

      const io = req.app.locals.io;
      if (io && newIds.length > 0) {
        const roomIdStr = room._id.toString();
        for (const addedId of newIds) {
          io.in(`user:${addedId}`).socketsJoin(`room:${roomIdStr}`);
          io.to(`user:${addedId}`).emit('room:created', {
            room: serializeRoom(populated, addedId),
          });
        }
        io.to(`room:${roomIdStr}`).emit('room:joined', {
          roomId: roomIdStr,
          addedMemberIds: newIds,
        });
      }

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
        const ownerCount = room.members.filter((m) => m.role === 'owner').length;
        if (ownerCount <= 1) {
          throw new AppError('Room owner must transfer ownership or delete the room first', 400);
        }
      }

      await Room.updateOne(
        { _id: room._id },
        { $pull: { members: { user: req.user.id } } }
      );

      const roomIdStr = room._id.toString();
      const io = req.app.locals.io;
      if (io) {
        io.in(`user:${req.user.id}`).socketsLeave(`room:${roomIdStr}`);
        io.to(`user:${req.user.id}`).emit('room:left', { roomId: roomIdStr });
        io.to(`room:${roomIdStr}`).emit('room:left', { roomId: roomIdStr, userId: req.user.id });
      }

      res.status(200).json({ ok: true, roomId: roomIdStr });
    })
  );

  // PATCH /api/rooms/:id — rename room or update room settings (owner/admin)
  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const parsed = updateRoomSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid room settings', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      if (room.type === 'dm') {
        throw new AppError('Direct messages cannot be modified', 400);
      }

      if (parsed.data.name !== undefined) {
        assertCan(req.user, 'room.rename', { room });
        if (room.nameLower === 'general') {
          throw new AppError('The General room cannot be renamed', 400);
        }
        room.name = parsed.data.name;
      }
      if (
        parsed.data.slowModeSeconds !== undefined ||
        parsed.data.announcementMode !== undefined ||
        parsed.data.maxMembers !== undefined ||
        parsed.data.allowInviteLinks !== undefined ||
        parsed.data.disappearingTtlSeconds !== undefined
      ) {
        assertCan(req.user, 'room.settings', { room });
        if (parsed.data.slowModeSeconds !== undefined) {
          room.slowModeSeconds = parsed.data.slowModeSeconds;
        }
        if (parsed.data.announcementMode !== undefined) {
          room.announcementMode = parsed.data.announcementMode;
        }
        if (parsed.data.maxMembers !== undefined) {
          if (parsed.data.maxMembers < room.members.length) {
            throw new AppError('maxMembers cannot be less than current member count', 400);
          }
          room.maxMembers = parsed.data.maxMembers;
        }
        if (parsed.data.allowInviteLinks !== undefined) {
          room.allowInviteLinks = parsed.data.allowInviteLinks;
        }
        if (parsed.data.disappearingTtlSeconds !== undefined) {
          // Changing disappearingTtlSeconds affects only NEW messages created afterwards.
          room.disappearingTtlSeconds = parsed.data.disappearingTtlSeconds;
        }
      }

      await room.save();
      const populated = await Room.findById(room._id).populate('members.user', 'username').lean();
      const serialized = serializeRoom(populated, req.user.id);

      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${room._id.toString()}`).emit('room:updated', {
          roomId: room._id.toString(),
          name: room.name,
          slowModeSeconds: room.slowModeSeconds,
          announcementMode: room.announcementMode,
          maxMembers: room.maxMembers,
          allowInviteLinks: room.allowInviteLinks,
          disappearingTtlSeconds: room.disappearingTtlSeconds,
        });
      }

      res.status(200).json({ room: serialized });
    })
  );

  // PATCH /api/rooms/:id/mute — mute/unmute notifications for a room
  router.patch(
    '/:id/mute',
    asyncHandler(async (req, res) => {
      const parsed = roomMuteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('Invalid mute payload', 400);
      }
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      await Room.updateOne(
        { _id: room._id, 'members.user': req.user.id },
        { $set: { 'members.$.muted': parsed.data.muted } }
      );
      res.status(200).json({ ok: true, roomId: room._id.toString(), muted: parsed.data.muted });
    })
  );

  // POST /api/rooms/:id/invites — create a revocable, expiring invite link
  router.post(
    '/:id/invites',
    asyncHandler(async (req, res) => {
      const parsed = createInviteSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid invite options', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      if (room.type === 'dm') {
        throw new AppError('Direct messages do not support invite links', 400);
      }
      if (room.allowInviteLinks === false) {
        throw new AppError('Invite links are disabled for this room', 403);
      }
      assertCan(req.user, 'invite.manage', { room });

      const rawToken = crypto.randomBytes(24).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + parsed.data.expiresInHours * 3600 * 1000);

      const invite = await InviteLink.create({
        room: room._id,
        createdBy: req.user.id,
        tokenHash,
        expiresAt,
        maxUses: parsed.data.maxUses,
      });

      await audit('invite.create', {
        actor: req.user.id,
        targetType: 'invite',
        targetId: invite._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { roomId: room._id.toString(), maxUses: parsed.data.maxUses },
      });

      res.status(201).json({
        invite: {
          id: invite._id.toString(),
          roomId: room._id.toString(),
          expiresAt: invite.expiresAt.toISOString(),
          maxUses: invite.maxUses,
          uses: invite.uses,
        },
        token: rawToken,
      });
    })
  );

  // GET /api/rooms/:id/invites — list active invite links (no hashes returned)
  router.get(
    '/:id/invites',
    asyncHandler(async (req, res) => {
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'invite.manage', { room });

      const invites = await InviteLink.find(
        { room: room._id, revokedAt: null },
        { tokenHash: 0 }
      )
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({ invites });
    })
  );

  // DELETE /api/rooms/:id/invites/:inviteId — revoke an invite link
  router.delete(
    '/:id/invites/:inviteId',
    asyncHandler(async (req, res) => {
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'invite.manage', { room });

      const inviteId = parseRoomId(req.params.inviteId);
      const invite = await InviteLink.findOneAndUpdate(
        { _id: inviteId, room: room._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { new: true }
      );
      if (!invite) {
        throw new AppError('Invite link not found', 404);
      }

      await audit('invite.revoke', {
        actor: req.user.id,
        targetType: 'invite',
        targetId: invite._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { roomId: room._id.toString() },
      });

      res.status(200).json({ ok: true });
    })
  );

  // POST /api/rooms/invites/:token/redeem — atomically redeem an invite link
  router.post(
    '/invites/:token/redeem',
    asyncHandler(async (req, res) => {
      const rawToken = String(req.params.token || '');
      if (!rawToken || rawToken.length < 16) {
        throw new AppError('Invalid invite link', 400);
      }

      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const now = new Date();

      const invite = await InviteLink.findOneAndUpdate(
        {
          tokenHash,
          revokedAt: null,
          $and: [
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
            { $or: [{ maxUses: null }, { $expr: { $lt: ['$uses', '$maxUses'] } }] },
          ],
        },
        { $inc: { uses: 1 } },
        { new: true }
      );

      if (!invite) {
        throw new AppError('Invite link is invalid, expired, or has reached its maximum uses', 400);
      }

      const room = await Room.findById(invite.room);
      if (!room || room.allowInviteLinks === false) {
        await InviteLink.updateOne({ _id: invite._id }, { $inc: { uses: -1 } });
        throw new AppError('Invite links are not enabled for this room', 403);
      }

      const userId = req.user.id;
      if ((room.bannedUsers || []).some((b) => b.user.toString() === userId)) {
        await InviteLink.updateOne({ _id: invite._id }, { $inc: { uses: -1 } });
        throw new AppError('You are banned from this room', 403);
      }

      const alreadyMember = room.members.some((m) => m.user.toString() === userId);
      if (!alreadyMember) {
        const updated = await Room.findOneAndUpdate(
          {
            _id: room._id,
            'members.user': { $ne: userId },
            $expr: {
              $lt: [{ $size: '$members' }, { $ifNull: ['$maxMembers', MAX_MEMBERS_PER_ROOM] }],
            },
          },
          {
            $push: {
              members: { user: userId, role: 'member', joinedAt: now, lastReadAt: now },
            },
          },
          { new: true }
        );
        if (!updated) {
          await InviteLink.updateOne({ _id: invite._id }, { $inc: { uses: -1 } });
          throw new AppError('Room has reached its member limit', 400);
        }
      }

      const populated = await Room.findById(room._id)
        .populate('members.user', 'username')
        .lean();
      const serialized = serializeRoom(populated, userId);

      const io = req.app.locals.io;
      if (io && !alreadyMember) {
        const roomIdStr = room._id.toString();
        io.in(`user:${userId}`).socketsJoin(`room:${roomIdStr}`);
        io.to(`user:${userId}`).emit('room:created', { room: serialized });
        io.to(`room:${roomIdStr}`).emit('room:joined', {
          roomId: roomIdStr,
          user: { id: userId, username: req.user.username },
        });
      }

      res.status(200).json({ room: serialized });
    })
  );

  // PATCH /api/rooms/:id/members/:userId/role — change a member's role or transfer ownership
  router.patch(
    '/:id/members/:userId/role',
    asyncHandler(async (req, res) => {
      const parsed = changeMemberRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid role', 400);
      }

      const targetUserId = parseRoomId(req.params.userId);
      const newRole = parsed.data.role;
      const { room, member: actorMember } = await getRoomIfMember(req.params.id, req.user.id);

      const targetMember = room.members.find((m) => m.user.toString() === targetUserId);
      if (!targetMember) {
        throw new AppError('Target member not found in this room', 404);
      }

      if (actorMember.role === 'owner' && targetMember.role === 'owner' && newRole !== 'owner') {
        const ownerCount = room.members.filter((m) => m.role === 'owner').length;
        if (ownerCount <= 1) {
          throw new AppError('The last room owner cannot be demoted without transferring ownership', 400);
        }
      }

      const action = newRole === 'owner' ? 'ownership.transfer' : 'role.change';
      assertCan(req.user, action, {
        room,
        targetUser: { id: targetUserId, role: targetMember.role },
        targetRole: newRole,
      });

      const previousRole = targetMember.role;
      if (newRole === 'owner') {
        actorMember.role = 'admin';
        targetMember.role = 'owner';
      } else {
        targetMember.role = newRole;
      }
      await room.save();

      await audit('room.role_change', {
        actor: req.user.id,
        targetType: 'room',
        targetId: room._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: {
          targetUserId,
          previousRole,
          newRole,
        },
      });

      const populated = await Room.findById(room._id).populate('members.user', 'username').lean();
      const serialized = serializeRoom(populated, req.user.id);
      const roomIdStr = room._id.toString();

      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${roomIdStr}`).emit('member:updated', {
          roomId: roomIdStr,
          userId: targetUserId,
          role: newRole,
          members: serialized.members,
        });
      }

      res.status(200).json({ room: serialized });
    })
  );

  // DELETE /api/rooms/:id/members/:userId — remove a member from a room
  router.delete(
    '/:id/members/:userId',
    asyncHandler(async (req, res) => {
      const targetUserId = parseRoomId(req.params.userId);
      const { room } = await getRoomIfMember(req.params.id, req.user.id);

      const targetMember = room.members.find((m) => m.user.toString() === targetUserId);
      if (!targetMember) {
        throw new AppError('Target member not found in this room', 404);
      }

      assertCan(req.user, 'member.remove', {
        room,
        targetUser: { id: targetUserId, role: targetMember.role },
      });

      await Room.updateOne(
        { _id: room._id },
        { $pull: { members: { user: targetUserId } } }
      );

      await audit('room.member_remove', {
        actor: req.user.id,
        targetType: 'room',
        targetId: room._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { targetUserId, removedRole: targetMember.role },
      });

      const roomIdStr = room._id.toString();
      const io = req.app.locals.io;
      if (io) {
        io.in(`user:${targetUserId}`).socketsLeave(`room:${roomIdStr}`);
        io.to(`user:${targetUserId}`).emit('room:left', { roomId: roomIdStr });
        io.to(`room:${roomIdStr}`).emit('room:left', { roomId: roomIdStr, userId: targetUserId });
      }

      res.status(200).json({ ok: true, roomId: roomIdStr, userId: targetUserId });
    })
  );

  // DELETE /api/rooms/:id — delete a room (owner only, cannot delete General or DMs)
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'room.delete', { room });
      if (room.type === 'dm' || room.nameLower === 'general') {
        throw new AppError('This room cannot be deleted', 400);
      }

      const roomIdStr = room._id.toString();
      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${roomIdStr}`).emit('room:left', { roomId: roomIdStr, deleted: true });
        io.in(`room:${roomIdStr}`).socketsLeave(`room:${roomIdStr}`);
      }

      await Promise.all([
        Message.deleteMany({ room: room._id }),
        Room.deleteOne({ _id: room._id }),
      ]);

      res.status(200).json({ ok: true, roomId: roomIdStr });
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

      const { before, after, around, limit } = parsed.data;
      const result = await getRoomMessages({
        roomId: req.params.id,
        userId: req.user.id,
        before,
        after,
        around,
        limit,
        storageService,
      });

      res.status(200).json(result);
    })
  );

  // GET /api/rooms/:id/pins — list pinned messages for a room
  router.get(
    '/:id/pins',
    asyncHandler(async (req, res) => {
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      const docs = await Message.find({
        _id: { $in: room.pinnedMessages || [] },
        room: room._id,
        deletedAt: null,
      })
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({ pins: docs.map(serializeMessage) });
    })
  );

  // POST /api/rooms/:id/pins/:messageId — pin a message (moderator+, max 10)
  router.post(
    '/:id/pins/:messageId',
    asyncHandler(async (req, res) => {
      const messageId = parseRoomId(req.params.messageId);
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'message.pin', { room });

      const msg = await Message.findOne({ _id: messageId, room: room._id, deletedAt: null }).lean();
      if (!msg) {
        throw new AppError('Message not found', 404);
      }

      const existing = (room.pinnedMessages || []).map((id) => id.toString());
      if (!existing.includes(messageId)) {
        if (existing.length >= 10) {
          throw new AppError('A room can have at most 10 pinned messages', 400);
        }
        room.pinnedMessages.push(messageId);
        await room.save();
      }

      const roomIdStr = room._id.toString();
      const pinnedIds = room.pinnedMessages.map((id) => id.toString());
      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${roomIdStr}`).emit('room:pins_updated', {
          roomId: roomIdStr,
          pinnedMessages: pinnedIds,
        });
      }

      res.status(200).json({ pinnedMessages: pinnedIds });
    })
  );

  // DELETE /api/rooms/:id/pins/:messageId — unpin a message (moderator+)
  router.delete(
    '/:id/pins/:messageId',
    asyncHandler(async (req, res) => {
      const messageId = parseRoomId(req.params.messageId);
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'message.pin', { room });

      await Room.updateOne({ _id: room._id }, { $pull: { pinnedMessages: messageId } });
      const updated = await Room.findById(room._id, { pinnedMessages: 1 }).lean();
      const pinnedIds = (updated?.pinnedMessages || []).map((id) => id.toString());
      const roomIdStr = room._id.toString();

      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${roomIdStr}`).emit('room:pins_updated', {
          roomId: roomIdStr,
          pinnedMessages: pinnedIds,
        });
      }

      res.status(200).json({ pinnedMessages: pinnedIds });
    })
  );

  // PUT /api/rooms/:id/draft — save/sync draft across user's devices
  router.put(
    '/:id/draft',
    asyncHandler(async (req, res) => {
      const parsed = draftSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid draft', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      const text = parsed.data.text;

      if (!text) {
        await Draft.deleteOne({ user: req.user.id, room: room._id });
      } else {
        await Draft.updateOne(
          { user: req.user.id, room: room._id },
          { $set: { text } },
          { upsert: true }
        );
      }

      const roomIdStr = room._id.toString();
      const io = req.app.locals.io;
      if (io) {
        io.to(`user:${req.user.id}`).emit('draft:updated', { roomId: roomIdStr, text });
      }

      res.status(200).json({ ok: true, roomId: roomIdStr, text });
    })
  );

  // PATCH /api/rooms/:id/notifications — per-room notification level (all | mentions | muted)
  router.patch(
    '/:id/notifications',
    asyncHandler(async (req, res) => {
      const parsed = notificationLevelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid notification level', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      const level = parsed.data.level;
      await Room.updateOne(
        { _id: room._id, 'members.user': req.user.id },
        {
          $set: {
            'members.$.notificationLevel': level,
            'members.$.muted': level === 'muted',
          },
        }
      );

      res.status(200).json({ ok: true, roomId: room._id.toString(), level });
    })
  );

  // POST /api/rooms/:id/scheduled — schedule a message 1m to 30d ahead (max 20 pending per user)
  router.post(
    '/:id/scheduled',
    requireFeature('scheduledMessages'),
    asyncHandler(async (req, res) => {
      const parsed = scheduleMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid scheduled message', 400);
      }

      const sendAt = new Date(parsed.data.sendAt);
      const nowMs = Date.now();
      const minMs = nowMs + 60 * 1000;
      const maxMs = nowMs + 30 * 24 * 60 * 60 * 1000;
      if (sendAt.getTime() < minMs || sendAt.getTime() > maxMs) {
        throw new AppError('sendAt must be between 1 minute and 30 days from now', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'message.send', { room });

      const pendingCount = await ScheduledMessage.countDocuments({
        sender: req.user.id,
        status: 'pending',
      });
      if (pendingCount >= 20) {
        throw new AppError('Maximum 20 pending scheduled messages allowed', 400);
      }

      const scheduled = await ScheduledMessage.create({
        room: room._id,
        sender: req.user.id,
        senderName: req.user.username,
        text: parsed.data.text,
        sendAt,
      });

      res.status(201).json({ scheduled });
    })
  );

  // GET /api/rooms/:id/scheduled — list my pending scheduled messages in this room
  router.get(
    '/:id/scheduled',
    asyncHandler(async (req, res) => {
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      const scheduled = await ScheduledMessage.find({
        room: room._id,
        sender: req.user.id,
        status: 'pending',
      })
        .sort({ sendAt: 1 })
        .lean();

      res.status(200).json({ scheduled });
    })
  );

  // DELETE /api/rooms/:id/scheduled/:scheduledId — cancel my pending scheduled message
  router.delete(
    '/:id/scheduled/:scheduledId',
    asyncHandler(async (req, res) => {
      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      const scheduledId = parseRoomId(req.params.scheduledId);

      const updated = await ScheduledMessage.findOneAndUpdate(
        { _id: scheduledId, room: room._id, sender: req.user.id, status: 'pending' },
        { $set: { status: 'cancelled' } },
        { new: true }
      );
      if (!updated) {
        throw new AppError('Scheduled message not found', 404);
      }

      res.status(200).json({ ok: true, id: scheduledId });
    })
  );

  // POST /api/rooms/:id/polls — create a poll message
  router.post(
    '/:id/polls',
    requireFeature('polls'),
    asyncHandler(async (req, res) => {
      const parsed = createPollSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid poll', 400);
      }

      const { room } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'message.send', { room });

      const { question, options, multiple, anonymous, closesAt } = parsed.data;
      const expiresAt =
        room.disappearingTtlSeconds > 0
          ? new Date(Date.now() + room.disappearingTtlSeconds * 1000)
          : null;

      const doc = await Message.create({
        room: room._id,
        sender: req.user.id,
        senderName: req.user.username,
        kind: 'poll',
        text: question,
        poll: {
          question,
          options: options.map((text, idx) => ({ id: `opt_${idx + 1}`, text, votes: [] })),
          multiple,
          anonymous,
          closesAt: closesAt ? new Date(closesAt) : null,
        },
        expiresAt,
      });

      const serialized = serializeMessage(doc);
      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${room._id.toString()}`).emit('message:new', serialized);
      }

      res.status(201).json({ message: serialized });
    })
  );

  // GET /api/rooms/:id/changes?since=<ISO> — syncs new, edited, and deleted messages
  router.get(
    '/:id/changes',
    asyncHandler(async (req, res) => {
      const parsed = roomChangesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid since parameter', 400);
      }

      const result = await getRoomChanges({
        roomId: req.params.id,
        userId: req.user.id,
        since: parsed.data.since,
        storageService,
      });

      res.status(200).json(result);
    })
  );

  // POST /api/rooms/:id/summary — AI "Catch me up" summary of unread (or recent 50) non-deleted messages
  router.post(
    '/:id/summary',
    requireFeature('aiSummaries'),
    ...(summaryRateLimiter ? [summaryRateLimiter] : []),
    asyncHandler(async (req, res) => {
      const parsed = roomSummarySchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid summary request', 400);
      }

      const { sinceMessageId, force } = parsed.data;
      const { room, member } = await getRoomIfMember(req.params.id, req.user.id);
      assertCan(req.user, 'room.summary', { room });

      let sinceDate = member.lastReadAt || member.joinedAt || new Date(0);
      if (sinceMessageId) {
        const anchor = await Message.findOne(
          { _id: sinceMessageId, room: room._id },
          { createdAt: 1 }
        ).lean();
        if (anchor?.createdAt) {
          sinceDate = anchor.createdAt;
        }
      }

      // Load up to 200 unread non-deleted messages (oldest first).
      let docs = await Message.find({
        room: room._id,
        deletedAt: null,
        createdAt: { $gt: sinceDate },
      })
        .sort({ createdAt: 1 })
        .limit(200)
        .lean();

      // Fall back to the most recent 50 non-deleted messages if nothing is unread.
      if (docs.length === 0) {
        docs = await Message.find({
          room: room._id,
          deletedAt: null,
        })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();
        docs.reverse();
      }

      const result = await summaryService.summarize({
        roomId: room._id.toString(),
        messages: docs,
        force,
      });

      res.status(200).json(result);
    })
  );

  return router;
}
