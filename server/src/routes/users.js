import { Router } from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { userSearchQuerySchema } from '../utils/validators.js';

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

  return router;
}
