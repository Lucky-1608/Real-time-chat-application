import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { resolveWorkspace } from '../middleware/workspace.js';
import { requireFeature } from '../services/featureFlags.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { answerWorkspaceQuestion } from '../services/ai/askService.js';
import { objectIdSchema } from '../utils/validators.js';

const askSchema = z.object({
  question: z.string().trim().min(3, 'Question must be at least 3 characters').max(500),
  roomId: objectIdSchema.nullable().optional().default(null),
});

export function createAiRouter({ rateLimiter, askLlmProvider } = {}) {
  const router = Router();
  router.use(requireAuth, resolveWorkspace);
  if (rateLimiter) router.use(rateLimiter);

  const askLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 15,
    keyGenerator: (req) => `ai-ask:${req.user?.id || req.ip}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'AI Q&A rate limit exceeded' },
  });

  router.post(
    '/ask',
    requireFeature('aiAsk'),
    askLimiter,
    asyncHandler(async (req, res) => {
      const parsed = askSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid question payload', 400);
      }

      const result = await answerWorkspaceQuestion({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        question: parsed.data.question,
        roomId: parsed.data.roomId || null,
        ...(askLlmProvider ? { askLlmProvider } : {}),
      });

      res.status(200).json(result);
    })
  );

  return router;
}
