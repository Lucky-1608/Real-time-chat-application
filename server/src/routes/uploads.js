import { Router } from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveWorkspace } from '../middleware/workspace.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { presignUploadSchema } from '../utils/validators.js';
import { getRoomIfMember } from '../services/roomAccess.js';
import { assertCan } from '../services/permissions.js';
import { requireFeature } from '../services/featureFlags.js';
import { defaultStorageService } from '../services/storage.js';
import { defaultFloodControl } from '../services/floodControl.js';

export function createUploadsRouter({
  rateLimiter,
  storageService = defaultStorageService,
  floodControl = defaultFloodControl,
} = {}) {
  const router = Router();

  router.use(requireAuth, resolveWorkspace);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  router.post(
    '/presign',
    requireFeature('uploads'),
    asyncHandler(async (req, res) => {
      const parsed = presignUploadSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid upload request', 400);
      }

      const { roomId, contentType, size } = parsed.data;
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertCan(req.user, 'message.send', { room });

      const user = await User.findById(req.user.id, { createdAt: 1 }).lean();
      floodControl.assertNewAccountAllowed(user?.createdAt, 'uploading files');

      const presigned = await storageService.createPresignedUpload({
        roomId,
        contentType,
        size,
      });

      res.status(200).json(presigned);
    })
  );

  return router;
}
