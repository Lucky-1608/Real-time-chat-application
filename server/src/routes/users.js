import { Router } from 'express';
import User from '../models/User.js';
import Room from '../models/Room.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import StarredMessage from '../models/StarredMessage.js';
import Draft from '../models/Draft.js';
import { serializeMessage } from '../models/Message.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveWorkspace } from '../middleware/workspace.js';
import { assertCan } from '../services/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { objectIdSchema, userSearchQuerySchema, userStatusSchema } from '../utils/validators.js';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createUsersRouter({ rateLimiter } = {}) {
  const router = Router();

  router.use(requireAuth);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  // GET /api/users?q= — search workspace members by username prefix (excludes self, max 20; blocked for guests)
  router.get(
    '/',
    resolveWorkspace,
    asyncHandler(async (req, res) => {
      assertCan(
        req.user,
        'workspace.members.list',
        { workspaceRole: req.workspaceMember?.role },
        'Guests cannot list workspace members'
      );

      const parsed = userSearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid search query', 400);
      }

      const wsMembers = await WorkspaceMember.find(
        { workspace: req.workspaceId, status: 'active', user: { $ne: req.user.id } },
        { user: 1 }
      ).lean();
      const memberIds = wsMembers.map((m) => m.user);
      if (memberIds.length === 0) {
        return res.status(200).json({ users: [] });
      }

      const { q } = parsed.data;
      const filter = {
        _id: { $in: memberIds },
      };

      if (q) {
        filter.usernameLower = { $regex: `^${escapeRegex(q.toLowerCase())}` };
      }

      const users = await User.find(filter, { _id: 1, username: 1 })
        .sort({ usernameLower: 1 })
        .limit(20)
        .lean();

      res.status(200).json({
        users: users.map((u) => ({
          id: u._id.toString(),
          username: u.username,
        })),
      });
    })
  );

  router.get(
    '/me/safety',
    asyncHandler(async (req, res) => {
      const user = await User.findById(req.user.id, { blockedUsers: 1, mutedUsers: 1 }).lean();
      res.status(200).json({
        blockedUsers: (user?.blockedUsers || []).map((id) => id.toString()),
        mutedUsers: (user?.mutedUsers || []).map((id) => id.toString()),
      });
    })
  );

  router.post(
    '/:id/block',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);
      if (parsed.data === req.user.id) throw new AppError('Cannot block yourself', 400);

      await User.updateOne(
        { _id: req.user.id },
        { $addToSet: { blockedUsers: parsed.data } }
      );
      res.status(200).json({ ok: true, blockedUserId: parsed.data });
    })
  );

  router.delete(
    '/:id/block',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);

      await User.updateOne(
        { _id: req.user.id },
        { $pull: { blockedUsers: parsed.data } }
      );
      res.status(200).json({ ok: true, unblockedUserId: parsed.data });
    })
  );

  router.post(
    '/:id/mute',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);
      if (parsed.data === req.user.id) throw new AppError('Cannot mute yourself', 400);

      await User.updateOne(
        { _id: req.user.id },
        { $addToSet: { mutedUsers: parsed.data } }
      );
      res.status(200).json({ ok: true, mutedUserId: parsed.data });
    })
  );

  router.delete(
    '/:id/mute',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);

      await User.updateOne(
        { _id: req.user.id },
        { $pull: { mutedUsers: parsed.data } }
      );
      res.status(200).json({ ok: true, unmutedUserId: parsed.data });
    })
  );

  // GET /api/users/me/stars — returns starred messages ONLY for rooms user still belongs to
  router.get(
    '/me/stars',
    asyncHandler(async (req, res) => {
      const myRooms = await Room.find(
        { 'members.user': req.user.id },
        { _id: 1, name: 1, type: 1 },
        { bypassTenantScope: true }
      ).lean();
      const allowedRoomIds = new Set(myRooms.map((r) => r._id.toString()));
      const roomById = new Map(myRooms.map((r) => [r._id.toString(), r]));

      const stars = await StarredMessage.find({ user: req.user.id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate({ path: 'message', options: { bypassTenantScope: true } })
        .lean();

      const valid = stars
        .filter((s) => s.message && !s.message.deletedAt && allowedRoomIds.has(s.room.toString()))
        .map((s) => {
          const r = roomById.get(s.room.toString());
          return {
            _id: s._id.toString(),
            roomId: s.room.toString(),
            roomName: r?.type === 'dm' ? 'Direct Message' : r?.name || 'Room',
            starredAt: s.createdAt,
            message: serializeMessage(s.message),
          };
        });

      res.status(200).json({ stars: valid });
    })
  );

  // GET /api/users/me/drafts — returns saved drafts per room
  router.get(
    '/me/drafts',
    asyncHandler(async (req, res) => {
      const docs = await Draft.find({ user: req.user.id }).lean();
      const drafts = {};
      for (const d of docs) {
        drafts[d.room.toString()] = d.text;
      }
      res.status(200).json({ drafts });
    })
  );

  // PUT /api/users/me/status — update custom status & DND, broadcast to shared-room members only
  router.put(
    '/me/status',
    asyncHandler(async (req, res) => {
      const parsed = userStatusSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid status payload', 400);
      }

      const { text, emoji, expiresAt, dndEnabled, dndUntil, appearOffline, globalMute } = parsed.data;
      const update = {
        customStatus: {
          text: text || '',
          emoji: emoji || '',
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      };
      if (dndEnabled !== undefined) update['dnd.enabled'] = dndEnabled;
      if (dndUntil !== undefined) update['dnd.until'] = dndUntil ? new Date(dndUntil) : null;
      if (appearOffline !== undefined) update['dnd.appearOffline'] = appearOffline;
      if (globalMute !== undefined) update.globalMute = globalMute;

      const user = await User.findByIdAndUpdate(
        req.user.id,
        { $set: update },
        { new: true, select: { customStatus: 1, dnd: 1, globalMute: 1 } }
      ).lean();

      const sharedRooms = await Room.find(
        { 'members.user': req.user.id },
        { members: 1 },
        { bypassTenantScope: true }
      ).lean();
      const recipientIds = new Set();
      for (const r of sharedRooms) {
        for (const m of r.members || []) {
          recipientIds.add(m.user.toString());
        }
      }

      const io = req.app.locals.io;
      if (io) {
        const payload = {
          userId: req.user.id,
          customStatus: user.customStatus,
          dnd: user.dnd,
        };
        for (const memberId of recipientIds) {
          io.to(`user:${memberId}`).emit('user:status_updated', payload);
        }
      }

      res.status(200).json({
        customStatus: user.customStatus,
        dnd: user.dnd,
        globalMute: Boolean(user.globalMute),
      });
    })
  );

  return router;
}
