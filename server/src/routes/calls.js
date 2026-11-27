import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireFeature } from '../services/featureFlags.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { defaultTurnProvider } from '../services/providers/turnProvider.js';

export function createCallsRouter({ rateLimiter, turnProvider = defaultTurnProvider } = {}) {
  const router = Router();
  router.use(requireAuth);
  if (rateLimiter) router.use(rateLimiter);

  router.get(
    '/ice-servers',
    requireFeature('calls'),
    asyncHandler(async (req, res) => {
      const config = await turnProvider.getIceServers(req.user.id);
      res.status(200).json(config);
    })
  );

  return router;
}
