import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { resolveWorkspace } from '../middleware/workspace.js';
import { requireFeature } from '../services/featureFlags.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { semanticSearchMessages } from '../services/search/embeddingService.js';
import { objectIdSchema } from '../utils/validators.js';

const semanticSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Query must be at least 2 characters').max(300),
  roomId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
});

export function createSearchRouter({ rateLimiter } = {}) {
  const router = Router();
  router.use(requireAuth, resolveWorkspace);
  if (rateLimiter) router.use(rateLimiter);

  router.get(
    '/semantic',
    requireFeature('semanticSearch'),
    asyncHandler(async (req, res) => {
      const parsed = semanticSearchQuerySchema.safeParse(req.query || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid search query', 400);
      }

      const { q, roomId, limit } = parsed.data;
      const result = await semanticSearchMessages({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        query: q,
        roomId: roomId || null,
        limit,
      });

      if (result.blockedByPolicy) {
        throw new AppError(
          'Semantic search requires "Allow external processing" in workspace settings',
          403
        );
      }

      res.status(200).json({ results: result.results });
    })
  );

  return router;
}
