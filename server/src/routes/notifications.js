import { Router } from 'express';
import { z } from 'zod';
import PushSubscription from '../models/PushSubscription.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFeature } from '../services/featureFlags.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { encryptField } from '../services/cryptoService.js';
import { defaultPushProvider } from '../services/providers/pushProvider.js';

const subscribeSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .max(1000)
    .refine((val) => {
      try {
        return new URL(val).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Push endpoint must use HTTPS'),
  keys: z.object({
    p256dh: z.string().min(8).max(500),
    auth: z.string().min(8).max(200),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().trim().min(1).max(1000),
});

export function createNotificationsRouter({ rateLimiter, pushProvider = defaultPushProvider } = {}) {
  const router = Router();
  router.use(requireAuth);
  if (rateLimiter) router.use(rateLimiter);

  router.get(
    '/push/vapid-public-key',
    requireFeature('notifications'),
    (_req, res) => {
      res.status(200).json({ publicKey: pushProvider.publicKey });
    }
  );

  router.post(
    '/push/subscribe',
    requireFeature('notifications'),
    asyncHandler(async (req, res) => {
      const parsed = subscribeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid push subscription', 400);
      }

      const keysEnc = encryptField(JSON.stringify(parsed.data.keys));
      await PushSubscription.updateOne(
        { user: req.user.id, endpoint: parsed.data.endpoint },
        {
          $set: {
            keysEnc,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null,
          },
        },
        { upsert: true }
      );

      res.status(201).json({ ok: true });
    })
  );

  router.delete(
    '/push/subscribe',
    requireFeature('notifications'),
    asyncHandler(async (req, res) => {
      const parsed = unsubscribeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid endpoint', 400);
      }

      await PushSubscription.deleteOne({ user: req.user.id, endpoint: parsed.data.endpoint });
      res.status(200).json({ ok: true });
    })
  );

  return router;
}
