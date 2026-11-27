import crypto from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import IncomingWebhook from '../models/IncomingWebhook.js';
import WebhookDelivery from '../models/WebhookDelivery.js';
import WebhookIdempotency from '../models/WebhookIdempotency.js';
import Room from '../models/Room.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveWorkspace } from '../middleware/workspace.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { can } from '../services/permissions.js';
import { requireFeature } from '../services/featureFlags.js';
import { audit } from '../services/auditService.js';
import { encryptField } from '../services/cryptoService.js';
import { getRoomIfMember, parseRoomId } from '../services/roomAccess.js';
import { deliverMessage } from '../services/messageService.js';
import { getWebhookFormatter } from '../services/webhooks/formatters/index.js';
import { objectIdSchema } from '../utils/validators.js';

const createWebhookSchema = z.object({
  name: z.string().trim().min(2).max(40),
  formatter: z.enum(['generic', 'github']).optional().default('generic'),
});

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function verifyTokenHash(rawToken, storedHash) {
  const incomingHash = hashToken(rawToken);
  const a = Buffer.from(incomingHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertWebhookManager(user, room, workspaceMember) {
  const isWsAdmin = can(user, 'workspace.members.manage', { workspaceRole: workspaceMember?.role });
  const isRoomOwner = can(user, 'room.delete', { room });
  if (!isWsAdmin && !isRoomOwner) {
    throw new AppError('Only workspace admins or room owners can manage webhooks', 403);
  }
}

export function createWebhooksRouter({ rateLimiter } = {}) {
  const router = Router();

  const perWebhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    keyGenerator: (req) => `hook:${req.params.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Webhook rate limit exceeded' },
  });

  // POST /api/v1/hooks/:id/:token — public incoming webhook receiver (64KB max)
  router.post(
    '/hooks/:id/:token',
    requireFeature('incomingWebhooks'),
    perWebhookLimiter,
    asyncHandler(async (req, res) => {
      const idCheck = objectIdSchema.safeParse(req.params.id);
      const rawToken = String(req.params.token || '').trim();
      if (!idCheck.success || rawToken.length < 16 || rawToken.length > 128) {
        throw new AppError('Invalid webhook credentials', 401);
      }

      const webhook = await IncomingWebhook.findOne({
        _id: idCheck.data,
        disabledAt: null,
      }).lean();

      if (!webhook || !verifyTokenHash(rawToken, webhook.tokenHash)) {
        throw new AppError('Invalid or disabled webhook', 401);
      }

      const formatter = getWebhookFormatter(webhook.formatter);
      if (!formatter) {
        throw new AppError('Unsupported webhook formatter', 500);
      }

      const formatted = formatter.format({
        body: req.body,
        headers: req.headers,
        rawBody: req.rawBody,
        webhook,
      });

      if (!formatted.ok) {
        await WebhookDelivery.create({
          webhook: webhook._id,
          workspace: webhook.workspace,
          status: 'rejected',
          httpStatus: formatted.status || 400,
          eventType: webhook.formatter,
          error: formatted.error,
        });
        throw new AppError(formatted.error, formatted.status || 400);
      }

      // Idempotency-Key deduplication (24h TTL)
      const idempKey = String(req.headers['idempotency-key'] || '').trim();
      if (idempKey) {
        if (idempKey.length > 128) {
          throw new AppError('Idempotency-Key too long (max 128 chars)', 400);
        }
        try {
          await WebhookIdempotency.create({ webhook: webhook._id, key: idempKey });
        } catch (err) {
          if (err.code === 11000) {
            await WebhookDelivery.create({
              webhook: webhook._id,
              workspace: webhook.workspace,
              status: 'deduplicated',
              httpStatus: 200,
              eventType: formatted.eventType,
            });
            return res.status(200).json({ ok: true, deduplicated: true });
          }
          throw err;
        }
      }

      // Enforce workspace + room binding strictly
      const room = await Room.findOne({
        _id: webhook.room,
        workspace: webhook.workspace,
      }).lean();
      if (!room) {
        throw new AppError('Target room not found in webhook workspace', 404);
      }

      const delivered = await deliverMessage({
        room,
        userId: webhook.botUserId.toString(),
        username: formatted.senderName || webhook.name,
        isBot: true,
        text: formatted.text,
        io: req.app.locals.io,
        presence: req.app.locals.presence,
      });

      if (!delivered.ok) {
        throw new AppError(delivered.error || 'Failed to deliver webhook message', 400);
      }

      await Promise.all([
        IncomingWebhook.updateOne({ _id: webhook._id }, { $set: { lastUsedAt: new Date() } }),
        WebhookDelivery.create({
          webhook: webhook._id,
          workspace: webhook.workspace,
          status: 'delivered',
          httpStatus: 201,
          eventType: formatted.eventType,
        }),
      ]);

      return res.status(201).json({ ok: true, message: delivered.message });
    })
  );

  // Authenticated webhook management routes
  const mgmt = Router();
  mgmt.use(requireAuth, resolveWorkspace);
  if (rateLimiter) mgmt.use(rateLimiter);

  mgmt.get(
    '/rooms/:id/webhooks',
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertWebhookManager(req.user, room, req.workspaceMember);

      const webhooks = await IncomingWebhook.find(
        { workspace: req.workspaceId, room: room._id, disabledAt: null },
        { tokenHash: 0, signingSecretEnc: 0 }
      )
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({ webhooks });
    })
  );

  mgmt.post(
    '/rooms/:id/webhooks',
    requireFeature('incomingWebhooks'),
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertWebhookManager(req.user, room, req.workspaceMember);

      const parsed = createWebhookSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid webhook payload', 400);
      }

      const { name, formatter } = parsed.data;
      const suffix = crypto.randomBytes(3).toString('hex');
      const botUsername = `hook_${suffix}`;
      const botUser = await User.create({
        username: botUsername,
        usernameLower: botUsername.toLowerCase(),
        passwordHash: `!hook-no-login-${crypto.randomBytes(32).toString('hex')}`,
        isSystem: true,
        isBot: true,
      });

      await Room.updateOne(
        { _id: room._id, workspace: req.workspaceId, 'members.user': { $ne: botUser._id } },
        { $push: { members: { user: botUser._id, role: 'member' } } }
      );

      const rawToken = crypto.randomBytes(24).toString('hex');
      const rawSigningSecret = formatter === 'github' ? crypto.randomBytes(24).toString('hex') : null;

      const webhook = await IncomingWebhook.create({
        workspace: req.workspaceId,
        room: room._id,
        name,
        formatter,
        tokenHash: hashToken(rawToken),
        signingSecretEnc: rawSigningSecret ? encryptField(rawSigningSecret) : null,
        botUserId: botUser._id,
        createdBy: req.user.id,
      });

      await audit('webhook.incoming.created', {
        actor: req.user.id,
        targetType: 'IncomingWebhook',
        targetId: webhook._id.toString(),
        metadata: { workspaceId: req.workspaceId, roomId: room._id.toString(), formatter },
        ip: req.ip,
      });

      res.status(201).json({
        webhook: {
          _id: webhook._id.toString(),
          name: webhook.name,
          formatter: webhook.formatter,
          room: webhook.room.toString(),
          createdAt: webhook.createdAt,
        },
        token: rawToken,
        ...(rawSigningSecret ? { signingSecret: rawSigningSecret } : {}),
      });
    })
  );

  mgmt.post(
    '/rooms/:id/webhooks/:hookId/rotate',
    requireFeature('incomingWebhooks'),
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      if (!mongoose.isValidObjectId(req.params.hookId)) {
        throw new AppError('Invalid webhook ID', 400);
      }
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertWebhookManager(req.user, room, req.workspaceMember);

      const rawToken = crypto.randomBytes(24).toString('hex');
      const updated = await IncomingWebhook.findOneAndUpdate(
        { _id: req.params.hookId, workspace: req.workspaceId, room: room._id, disabledAt: null },
        { $set: { tokenHash: hashToken(rawToken) } },
        { new: true }
      );
      if (!updated) throw new AppError('Webhook not found', 404);

      await audit('webhook.incoming.rotated', {
        actor: req.user.id,
        targetType: 'IncomingWebhook',
        targetId: updated._id.toString(),
        ip: req.ip,
      });

      res.status(200).json({ ok: true, token: rawToken });
    })
  );

  mgmt.delete(
    '/rooms/:id/webhooks/:hookId',
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      if (!mongoose.isValidObjectId(req.params.hookId)) {
        throw new AppError('Invalid webhook ID', 400);
      }
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertWebhookManager(req.user, room, req.workspaceMember);

      const updated = await IncomingWebhook.findOneAndUpdate(
        { _id: req.params.hookId, workspace: req.workspaceId, room: room._id, disabledAt: null },
        { $set: { disabledAt: new Date() } },
        { new: true }
      );
      if (!updated) throw new AppError('Webhook not found', 404);

      await audit('webhook.incoming.revoked', {
        actor: req.user.id,
        targetType: 'IncomingWebhook',
        targetId: updated._id.toString(),
        ip: req.ip,
      });

      res.status(200).json({ ok: true });
    })
  );

  mgmt.get(
    '/rooms/:id/webhooks/:hookId/deliveries',
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      if (!mongoose.isValidObjectId(req.params.hookId)) {
        throw new AppError('Invalid webhook ID', 400);
      }
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertWebhookManager(req.user, room, req.workspaceMember);

      const hook = await IncomingWebhook.findOne({
        _id: req.params.hookId,
        workspace: req.workspaceId,
        room: room._id,
      }).lean();
      if (!hook) throw new AppError('Webhook not found', 404);

      const deliveries = await WebhookDelivery.find({ webhook: hook._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      res.status(200).json({ deliveries });
    })
  );

  router.use(mgmt);
  return router;
}
