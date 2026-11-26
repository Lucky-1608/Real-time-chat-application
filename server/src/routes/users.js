import { Router } from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { objectIdSchema, userSearchQuerySchema } from '../utils/validators.js';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createUsersRouter({ rateLimiter } = {}) {
  const router = Router();

  router.use(requireAuth);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  // GET /api/users?q= — search users by username prefix (excludes self, max 20)
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = userSearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid search query', 400);
      }

      const { q } = parsed.data;
      const filter = {
        _id: { $ne: req.user.id },
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

  return router;
}
