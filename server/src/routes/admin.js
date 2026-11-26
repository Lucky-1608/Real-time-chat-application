import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { objectIdSchema } from '../utils/validators.js';
import { queryAuditEvents } from '../services/auditService.js';

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

  return router;
}
