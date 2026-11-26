import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { objectIdSchema } from '../utils/validators.js';
import { audit, queryAuditEvents } from '../services/auditService.js';
import { revokeAllUserSessions } from '../services/sessionService.js';
import { FLAG_NAMES, getFlags, setFlag } from '../services/featureFlags.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';
import AuditEvent from '../models/AuditEvent.js';

const auditQuerySchema = z.object({
  actor: objectIdSchema.optional(),
  action: z.string().trim().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function createAdminRouter({ rateLimiter } = {}) {
  const router = Router();

  router.use(requireAuth, requireAdmin);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const parsed = auditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid audit query', 400);
      }

      const result = await queryAuditEvents(parsed.data);
      res.status(200).json(result);
    })
  );

  router.get(
    '/users',
    asyncHandler(async (req, res) => {
      const q = String(req.query.q || '').trim().toLowerCase();
      const filter = q ? { usernameLower: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {};
      const users = await User.find(filter, {
        username: 1,
        globalRole: 1,
        twoFactorEnabled: 1,
        suspendedAt: 1,
        suspensionReason: 1,
        createdAt: 1,
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      res.status(200).json({
        users: users.map((u) => ({
          id: u._id.toString(),
          username: u.username,
          globalRole: u.globalRole,
          twoFactorEnabled: Boolean(u.twoFactorEnabled),
          suspendedAt: u.suspendedAt,
          suspensionReason: u.suspensionReason,
          createdAt: u.createdAt,
        })),
      });
    })
  );

  router.post(
    '/users/:id/suspend',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);

      const reason = String(req.body?.reason || 'Suspended by administrator').slice(0, 300);
      const user = await User.findByIdAndUpdate(
        parsed.data,
        { $set: { suspendedAt: new Date(), suspensionReason: reason } },
        { new: true }
      );
      if (!user) throw new AppError('User not found', 404);

      const revokedIds = await revokeAllUserSessions(parsed.data, 'admin_suspended');
      const io = req.app.locals.io;
      if (io) {
        for (const sid of revokedIds) {
          io.to(`session:${sid}`).emit('session:revoked', { reason: 'Your account was suspended' });
          io.in(`session:${sid}`).disconnectSockets(true);
        }
      }

      await audit('admin.user_suspend', {
        actor: req.user.id,
        targetType: 'user',
        targetId: parsed.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { reason },
      });

      res.status(200).json({ ok: true });
    })
  );

  router.post(
    '/users/:id/unsuspend',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);

      const user = await User.findByIdAndUpdate(
        parsed.data,
        { $set: { suspendedAt: null, suspensionReason: null } },
        { new: true }
      );
      if (!user) throw new AppError('User not found', 404);

      await audit('admin.user_unsuspend', {
        actor: req.user.id,
        targetType: 'user',
        targetId: parsed.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      res.status(200).json({ ok: true });
    })
  );

  router.post(
    '/users/:id/force-logout',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid user ID', 400);

      const revokedIds = await revokeAllUserSessions(parsed.data, 'admin_force_logout');
      const io = req.app.locals.io;
      if (io) {
        for (const sid of revokedIds) {
          io.to(`session:${sid}`).emit('session:revoked', { reason: 'Signed out by administrator' });
          io.in(`session:${sid}`).disconnectSockets(true);
        }
      }

      await audit('admin.force_logout', {
        actor: req.user.id,
        targetType: 'user',
        targetId: parsed.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { revokedCount: revokedIds.length },
      });

      res.status(200).json({ ok: true, revokedCount: revokedIds.length });
    })
  );

  router.get(
    '/rooms',
    asyncHandler(async (_req, res) => {
      const rooms = await Room.find({}, { name: 1, type: 1, members: 1, slowModeSeconds: 1, announcementMode: 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      res.status(200).json({
        rooms: rooms.map((r) => ({
          id: r._id.toString(),
          name: r.type === 'dm' ? '[Direct Message]' : r.name,
          type: r.type,
          memberCount: (r.members || []).length,
          slowModeSeconds: r.slowModeSeconds || 0,
          announcementMode: Boolean(r.announcementMode),
          createdAt: r.createdAt,
        })),
      });
    })
  );

  router.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [usersCount, suspendedCount, roomsCount, uploadsCount, scanRejectionsCount, messagesPerDay] =
        await Promise.all([
          User.countDocuments({}),
          User.countDocuments({ suspendedAt: { $ne: null } }),
          Room.countDocuments({}),
          Message.countDocuments({ 'attachments.0': { $exists: true } }),
          AuditEvent.countDocuments({ action: 'upload.rejected' }),
          Message.aggregate([
            { $match: { createdAt: { $gte: sevenDaysAgo } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ]),
        ]);

      const activeSockets = req.app.locals.io?.sockets?.sockets?.size || 0;

      res.status(200).json({
        usersCount,
        suspendedCount,
        roomsCount,
        activeSockets,
        uploadsCount,
        scanRejectionsCount,
        messagesPerDay: messagesPerDay.map((d) => ({ date: d._id, count: d.count })),
      });
    })
  );

  router.get(
    '/flags',
    asyncHandler(async (_req, res) => {
      res.status(200).json({ flags: await getFlags({ bypassCache: true }) });
    })
  );

  router.patch(
    '/flags',
    asyncHandler(async (req, res) => {
      const schema = z.object({
        flag: z.enum(FLAG_NAMES),
        enabled: z.boolean(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid flag payload', 400);
      }

      const flags = await setFlag(parsed.data.flag, parsed.data.enabled, req.user.id);
      await audit('admin.flag_toggle', {
        actor: req.user.id,
        targetType: 'feature_flag',
        targetId: parsed.data.flag,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { enabled: parsed.data.enabled },
      });

      res.status(200).json({ flags });
    })
  );

  return router;
}
