import crypto from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import WorkspaceInvite from '../models/WorkspaceInvite.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCan, WORKSPACE_ROLES } from '../services/permissions.js';
import { requireFeature } from '../services/featureFlags.js';
import { audit } from '../services/auditService.js';
import {
  addDemoContent,
  removeDemoContent,
  seedWorkspaceOnboarding,
} from '../services/onboardingService.js';
import {
  createWorkspaceInviteSchema,
  createWorkspaceSchema,
  objectIdSchema,
  transferWorkspaceSchema,
  updateWorkspaceMemberSchema,
  updateWorkspaceSettingsSchema,
} from '../utils/validators.js';

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `ws-${crypto.randomBytes(3).toString('hex')}`;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function requireWorkspaceMembership(workspaceId, userId) {
  if (!mongoose.isValidObjectId(workspaceId)) {
    throw new AppError('Invalid workspace ID', 400);
  }
  const [workspace, membership] = await Promise.all([
    Workspace.findById(workspaceId).lean(),
    WorkspaceMember.findOne({ workspace: workspaceId, user: userId, status: 'active' }).lean(),
  ]);
  if (!workspace || !membership) {
    throw new AppError('Workspace not found', 404);
  }
  return { workspace, membership };
}

export function createWorkspacesRouter({ rateLimiter } = {}) {
  const router = Router();
  router.use(requireAuth);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  // GET /api/v1/workspaces — list workspaces the authenticated user belongs to
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const memberships = await WorkspaceMember.find({
        user: req.user.id,
        status: 'active',
      })
        .populate('workspace')
        .lean();

      const workspaces = memberships
        .filter((m) => m.workspace)
        .map((m) => ({
          _id: m.workspace._id.toString(),
          name: m.workspace.name,
          slug: m.workspace.slug,
          plan: m.workspace.plan,
          role: m.role,
          settings: m.workspace.settings || {},
          createdAt: m.workspace.createdAt,
        }));

      res.status(200).json({ workspaces });
    })
  );

  // POST /api/v1/workspaces — create a new workspace
  router.post(
    '/',
    requireFeature('workspaces'),
    asyncHandler(async (req, res) => {
      const parsed = createWorkspaceSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid workspace payload', 400);
      }

      const { name } = parsed.data;
      const slug = parsed.data.slug || slugify(name);

      const workspace = await Workspace.create({
        name,
        slug,
        ownerId: req.user.id,
        plan: 'free',
      });

      await WorkspaceMember.create({
        workspace: workspace._id,
        user: req.user.id,
        role: 'owner',
        status: 'active',
      });

      await seedWorkspaceOnboarding(workspace._id, req.user.id);

      await audit('workspace.created', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        metadata: { slug: workspace.slug },
        ip: req.ip,
      });

      res.status(201).json({
        workspace: {
          _id: workspace._id.toString(),
          name: workspace.name,
          slug: workspace.slug,
          plan: workspace.plan,
          role: 'owner',
          settings: workspace.settings,
        },
      });
    })
  );

  // GET /api/v1/workspaces/:id/members — list workspace members (blocked for guests)
  router.get(
    '/:id/members',
    asyncHandler(async (req, res) => {
      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.members.list', { workspaceRole: membership.role });

      const members = await WorkspaceMember.find({ workspace: workspace._id })
        .populate('user', 'username customStatus')
        .lean();

      res.status(200).json({
        members: members
          .filter((m) => m.user)
          .map((m) => ({
            userId: m.user._id.toString(),
            username: m.user.username,
            role: m.role,
            status: m.status,
            joinedAt: m.joinedAt,
          })),
      });
    })
  );

  // PATCH /api/v1/workspaces/:id/members/:userId — update member role or status
  router.patch(
    '/:id/members/:userId',
    asyncHandler(async (req, res) => {
      const targetUserId = objectIdSchema.safeParse(req.params.userId);
      if (!targetUserId.success) throw new AppError('Invalid user ID', 400);

      const parsed = updateWorkspaceMemberSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid member update', 400);
      }

      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      const targetMember = await WorkspaceMember.findOne({
        workspace: workspace._id,
        user: targetUserId.data,
      });
      if (!targetMember) {
        throw new AppError('Workspace member not found', 404);
      }

      assertCan(req.user, 'workspace.members.manage', {
        workspaceRole: membership.role,
        targetUser: { id: targetUserId.data, role: targetMember.role },
        targetRole: parsed.data.role,
      });

      if (
        targetMember.role === 'owner' &&
        ((parsed.data.role && parsed.data.role !== 'owner') || parsed.data.status === 'suspended')
      ) {
        const ownerCount = await WorkspaceMember.countDocuments({
          workspace: workspace._id,
          role: 'owner',
          status: 'active',
        });
        if (ownerCount <= 1) {
          throw new AppError('Cannot demote or suspend the last workspace owner', 400);
        }
      }

      if (parsed.data.role && WORKSPACE_ROLES.includes(parsed.data.role)) {
        targetMember.role = parsed.data.role;
      }
      if (parsed.data.status) {
        targetMember.status = parsed.data.status;
      }
      await targetMember.save();

      await audit('workspace.member_updated', {
        actor: req.user.id,
        targetType: 'WorkspaceMember',
        targetId: targetMember._id.toString(),
        metadata: { workspaceId: workspace._id.toString(), role: targetMember.role, status: targetMember.status },
        ip: req.ip,
      });

      res.status(200).json({
        member: {
          userId: targetMember.user.toString(),
          role: targetMember.role,
          status: targetMember.status,
        },
      });
    })
  );

  // DELETE /api/v1/workspaces/:id/members/:userId — remove member from workspace
  router.delete(
    '/:id/members/:userId',
    asyncHandler(async (req, res) => {
      const targetUserId = objectIdSchema.safeParse(req.params.userId);
      if (!targetUserId.success) throw new AppError('Invalid user ID', 400);

      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      const targetMember = await WorkspaceMember.findOne({
        workspace: workspace._id,
        user: targetUserId.data,
      });
      if (!targetMember) throw new AppError('Workspace member not found', 404);

      assertCan(req.user, 'workspace.members.manage', {
        workspaceRole: membership.role,
        targetUser: { id: targetUserId.data, role: targetMember.role },
      });

      if (targetMember.role === 'owner') {
        const ownerCount = await WorkspaceMember.countDocuments({
          workspace: workspace._id,
          role: 'owner',
          status: 'active',
        });
        if (ownerCount <= 1) {
          throw new AppError('Cannot remove the last workspace owner', 400);
        }
      }

      await WorkspaceMember.deleteOne({ _id: targetMember._id });
      await Room.updateMany(
        { workspace: workspace._id },
        { $pull: { members: { user: targetUserId.data } } }
      );

      await audit('workspace.member_removed', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        metadata: { removedUserId: targetUserId.data },
        ip: req.ip,
      });

      res.status(200).json({ ok: true });
    })
  );

  // PATCH /api/v1/workspaces/:id/settings — update workspace settings (owner/admin)
  router.patch(
    '/:id/settings',
    asyncHandler(async (req, res) => {
      const parsed = updateWorkspaceSettingsSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid settings payload', 400);
      }

      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.settings', { workspaceRole: membership.role });

      const $set = {};
      if (parsed.data.name !== undefined) $set.name = parsed.data.name;
      if (parsed.data.allowExternalProcessing !== undefined) {
        $set['settings.allowExternalProcessing'] = parsed.data.allowExternalProcessing;
      }
      if (parsed.data.allowedInviteDomains !== undefined) {
        $set['settings.allowedInviteDomains'] = parsed.data.allowedInviteDomains;
      }
      if (parsed.data.retentionDays !== undefined) {
        $set['settings.retentionDays'] = parsed.data.retentionDays;
      }

      const updated = await Workspace.findByIdAndUpdate(
        workspace._id,
        { $set },
        { new: true }
      ).lean();

      await audit('workspace.settings_updated', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        ip: req.ip,
      });

      res.status(200).json({ workspace: updated });
    })
  );

  // POST /api/v1/workspaces/:id/transfer — transfer ownership (owner only)
  router.post(
    '/:id/transfer',
    asyncHandler(async (req, res) => {
      const parsed = transferWorkspaceSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid transfer payload', 400);
      }

      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.transfer', { workspaceRole: membership.role });

      const targetMember = await WorkspaceMember.findOne({
        workspace: workspace._id,
        user: parsed.data.targetUserId,
        status: 'active',
      });
      if (!targetMember) {
        throw new AppError('Target user is not an active member of this workspace', 404);
      }

      await Promise.all([
        Workspace.updateOne({ _id: workspace._id }, { $set: { ownerId: parsed.data.targetUserId } }),
        WorkspaceMember.updateOne({ _id: targetMember._id }, { $set: { role: 'owner' } }),
        WorkspaceMember.updateOne(
          { workspace: workspace._id, user: req.user.id },
          { $set: { role: 'admin' } }
        ),
      ]);

      await audit('workspace.ownership_transferred', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        metadata: { newOwnerId: parsed.data.targetUserId },
        ip: req.ip,
      });

      res.status(200).json({ ok: true, ownerId: parsed.data.targetUserId });
    })
  );

  // DELETE /api/v1/workspaces/:id — delete workspace (owner only, not Default)
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.delete', { workspaceRole: membership.role });

      if (workspace.slug === 'default') {
        throw new AppError('Cannot delete the Default workspace', 400);
      }

      await Promise.all([
        Message.deleteMany({ workspace: workspace._id }),
        Room.deleteMany({ workspace: workspace._id }),
        WorkspaceInvite.deleteMany({ workspace: workspace._id }),
        WorkspaceMember.deleteMany({ workspace: workspace._id }),
        Workspace.deleteOne({ _id: workspace._id }),
      ]);

      await audit('workspace.deleted', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        ip: req.ip,
      });

      res.status(200).json({ ok: true });
    })
  );

  // POST /api/v1/workspaces/:id/invites — create workspace invite link/email
  router.post(
    '/:id/invites',
    requireFeature('workspaces'),
    asyncHandler(async (req, res) => {
      const parsed = createWorkspaceInviteSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid invite payload', 400);
      }

      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.invite.create', { workspaceRole: membership.role });

      const { email, role, expiresInHours, maxUses } = parsed.data;
      const allowedDomains = workspace.settings?.allowedInviteDomains || [];
      if (email && allowedDomains.length > 0) {
        const domain = email.split('@')[1]?.toLowerCase();
        if (!domain || !allowedDomains.includes(domain)) {
          throw new AppError('Email domain is not in allowedInviteDomains for this workspace', 403);
        }
      }

      const rawToken = crypto.randomBytes(24).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000) : null;

      const invite = await WorkspaceInvite.create({
        workspace: workspace._id,
        createdBy: req.user.id,
        tokenHash,
        email: email || null,
        role,
        expiresAt,
        maxUses,
      });

      await audit('workspace.invite_created', {
        actor: req.user.id,
        targetType: 'WorkspaceInvite',
        targetId: invite._id.toString(),
        metadata: { workspaceId: workspace._id.toString(), role },
        ip: req.ip,
      });

      res.status(201).json({
        invite: {
          _id: invite._id.toString(),
          role: invite.role,
          email: invite.email,
          expiresAt: invite.expiresAt,
          maxUses: invite.maxUses,
          uses: invite.uses,
        },
        token: rawToken,
      });
    })
  );

  // GET /api/v1/workspaces/:id/invites — list active invites (owner/admin)
  router.get(
    '/:id/invites',
    asyncHandler(async (req, res) => {
      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.invite.create', { workspaceRole: membership.role });

      const invites = await WorkspaceInvite.find(
        { workspace: workspace._id, revokedAt: null },
        { tokenHash: 0 }
      )
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      res.status(200).json({ invites });
    })
  );

  // DELETE /api/v1/workspaces/:id/invites/:inviteId — revoke an invite
  router.delete(
    '/:id/invites/:inviteId',
    asyncHandler(async (req, res) => {
      const inviteId = objectIdSchema.safeParse(req.params.inviteId);
      if (!inviteId.success) throw new AppError('Invalid invite ID', 400);

      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.invite.create', { workspaceRole: membership.role });

      const updated = await WorkspaceInvite.findOneAndUpdate(
        { _id: inviteId.data, workspace: workspace._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { new: true }
      );
      if (!updated) throw new AppError('Invite not found', 404);

      await audit('workspace.invite_revoked', {
        actor: req.user.id,
        targetType: 'WorkspaceInvite',
        targetId: updated._id.toString(),
        ip: req.ip,
      });

      res.status(200).json({ ok: true });
    })
  );

  // POST /api/v1/workspaces/invites/:token/redeem — atomically redeem a workspace invite
  router.post(
    '/invites/:token/redeem',
    asyncHandler(async (req, res) => {
      const rawToken = String(req.params.token || '').trim();
      if (rawToken.length < 16 || rawToken.length > 128) {
        throw new AppError('Invalid invite token', 400);
      }

      const tokenHash = hashToken(rawToken);
      const invite = await WorkspaceInvite.findOne({ tokenHash }).lean();
      if (!invite) {
        throw new AppError('Invite not found or expired', 404);
      }

      const workspace = await Workspace.findById(invite.workspace).lean();
      if (!workspace) {
        throw new AppError('Workspace not found', 404);
      }

      // Enforce allowedInviteDomains and email match BEFORE consuming a use
      const userDoc = await User.findById(req.user.id, { email: 1 }).lean();
      const userEmail = userDoc?.email?.toLowerCase() || null;

      if (invite.email && invite.email !== userEmail) {
        throw new AppError('This invite is restricted to a specific email address', 403);
      }

      const allowedDomains = workspace.settings?.allowedInviteDomains || [];
      if (allowedDomains.length > 0) {
        const domain = userEmail?.split('@')[1]?.toLowerCase();
        if (!domain || !allowedDomains.includes(domain)) {
          throw new AppError('Your email domain is not allowed in this workspace', 403);
        }
      }

      const now = new Date();
      const claimQuery = {
        _id: invite._id,
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      };
      if (invite.maxUses !== null && invite.maxUses !== undefined) {
        claimQuery.$expr = { $lt: ['$uses', '$maxUses'] };
      }

      const claimed = await WorkspaceInvite.findOneAndUpdate(
        claimQuery,
        { $inc: { uses: 1 } },
        { new: true }
      );

      if (!claimed) {
        throw new AppError('Invite link is expired, revoked, or exhausted', 410);
      }

      await WorkspaceMember.updateOne(
        { workspace: workspace._id, user: req.user.id },
        {
          $setOnInsert: {
            workspace: workspace._id,
            user: req.user.id,
            role: invite.role || 'member',
            status: 'active',
          },
        },
        { upsert: true }
      );

      await audit('workspace.invite_redeemed', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        metadata: { inviteId: invite._id.toString() },
        ip: req.ip,
      });

      res.status(200).json({
        workspace: {
          _id: workspace._id.toString(),
          name: workspace.name,
          slug: workspace.slug,
        },
        role: invite.role || 'member',
      });
    })
  );

  // POST /api/v1/workspaces/:id/demo — seed #demo-playground room & sample messages
  router.post(
    '/:id/demo',
    requireFeature('onboarding'),
    asyncHandler(async (req, res) => {
      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.rooms.create', { workspaceRole: membership.role });

      const { room, messageCount } = await addDemoContent(workspace._id, req.user.id);
      await audit('workspace.demo_added', {
        actor: req.user.id,
        targetType: 'Workspace',
        targetId: workspace._id.toString(),
        metadata: { roomId: room._id.toString() },
        ip: req.ip,
      });

      res.status(201).json({
        room: { _id: room._id.toString(), name: room.name, type: room.type },
        messageCount,
      });
    })
  );

  // DELETE /api/v1/workspaces/:id/demo — remove #demo-playground room & messages in one click
  router.delete(
    '/:id/demo',
    requireFeature('onboarding'),
    asyncHandler(async (req, res) => {
      const { workspace, membership } = await requireWorkspaceMembership(req.params.id, req.user.id);
      assertCan(req.user, 'workspace.rooms.create', { workspaceRole: membership.role });

      const { removed } = await removeDemoContent(workspace._id);
      if (removed) {
        await audit('workspace.demo_removed', {
          actor: req.user.id,
          targetType: 'Workspace',
          targetId: workspace._id.toString(),
          ip: req.ip,
        });
      }

      res.status(200).json({ removed });
    })
  );

  return router;
}
