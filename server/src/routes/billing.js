import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import Workspace from '../models/Workspace.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import BillingEvent from '../models/BillingEvent.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFeature } from '../services/featureFlags.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCan } from '../services/permissions.js';
import { audit } from '../services/auditService.js';
import { getPlanLimits } from '../services/billing/plans.js';
import { defaultPaymentProvider } from '../services/providers/paymentProvider.js';

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'team']),
});

export function createBillingRouter({
  rateLimiter,
  paymentProvider = defaultPaymentProvider,
} = {}) {
  const router = Router();

  // POST /api/v1/billing/webhook — Stripe-compatible signed webhook receiver
  router.post(
    '/billing/webhook',
    requireFeature('billing'),
    asyncHandler(async (req, res) => {
      const sig = req.headers['stripe-signature'];
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      if (!paymentProvider.verifyWebhookSignature(rawBody, sig)) {
        throw new AppError('Invalid billing webhook signature', 401);
      }

      const event = req.body || {};
      const eventId = String(event.id || '').trim();
      const eventType = String(event.type || '').trim();
      if (!eventId || !eventType) {
        throw new AppError('Invalid billing event payload', 400);
      }

      const meta = event.data?.object?.metadata || {};
      const workspaceId = mongoose.isValidObjectId(meta.workspaceId) ? meta.workspaceId : null;

      try {
        await BillingEvent.create({
          eventId,
          type: eventType,
          workspace: workspaceId,
        });
      } catch (err) {
        if (err.code === 11000) {
          return res.status(200).json({ ok: true, deduplicated: true });
        }
        throw err;
      }

      if (eventType === 'checkout.session.completed' && workspaceId) {
        const nextPlan = ['pro', 'team'].includes(meta.plan) ? meta.plan : 'pro';
        const ws = await Workspace.findByIdAndUpdate(
          workspaceId,
          { $set: { plan: nextPlan } },
          { new: true }
        );
        if (ws) {
          await audit('billing.plan_changed', {
            targetType: 'Workspace',
            targetId: ws._id.toString(),
            metadata: { plan: nextPlan, eventId },
            ip: req.ip,
          });
        }
      } else if (eventType === 'customer.subscription.deleted' && workspaceId) {
        const ws = await Workspace.findByIdAndUpdate(
          workspaceId,
          { $set: { plan: 'free' } },
          { new: true }
        );
        if (ws) {
          await audit('billing.plan_changed', {
            targetType: 'Workspace',
            targetId: ws._id.toString(),
            metadata: { plan: 'free', eventId },
            ip: req.ip,
          });
        }
      }

      return res.status(200).json({ ok: true, processed: true });
    })
  );

  // Authenticated workspace billing routes
  const wsAuth = rateLimiter ? [requireAuth, rateLimiter] : [requireAuth];

  router.get(
    '/workspaces/:id/billing',
    ...wsAuth,
    asyncHandler(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id)) {
        throw new AppError('Invalid workspace ID', 400);
      }
      const [workspace, membership] = await Promise.all([
        Workspace.findById(req.params.id).lean(),
        WorkspaceMember.findOne({
          workspace: req.params.id,
          user: req.user.id,
          status: 'active',
        }).lean(),
      ]);
      if (!workspace || !membership) throw new AppError('Workspace not found', 404);
      assertCan(req.user, 'workspace.settings', { workspaceRole: membership.role });

      const memberCount = await WorkspaceMember.countDocuments({
        workspace: workspace._id,
        status: 'active',
      });

      res.status(200).json({
        plan: workspace.plan || 'free',
        limits: getPlanLimits(workspace.plan || 'free'),
        usage: { members: memberCount },
      });
    })
  );

  router.post(
    '/workspaces/:id/billing/checkout',
    ...wsAuth,
    requireFeature('billing'),
    asyncHandler(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id)) {
        throw new AppError('Invalid workspace ID', 400);
      }
      const [workspace, membership] = await Promise.all([
        Workspace.findById(req.params.id).lean(),
        WorkspaceMember.findOne({
          workspace: req.params.id,
          user: req.user.id,
          status: 'active',
        }).lean(),
      ]);
      if (!workspace || !membership) throw new AppError('Workspace not found', 404);
      assertCan(req.user, 'workspace.transfer', { workspaceRole: membership.role });

      const parsed = checkoutSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid plan', 400);
      }

      const session = await paymentProvider.createCheckoutSession({
        workspaceId: workspace._id.toString(),
        plan: parsed.data.plan,
        userId: req.user.id,
      });

      res.status(200).json(session);
    })
  );

  return router;
}
