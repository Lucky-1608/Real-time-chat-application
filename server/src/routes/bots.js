import crypto from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import Bot from '../models/Bot.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveWorkspace } from '../middleware/workspace.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCan } from '../services/permissions.js';
import { requireFeature } from '../services/featureFlags.js';
import { audit } from '../services/auditService.js';
import { getRoomIfMember, parseRoomId } from '../services/roomAccess.js';
import { deliverMessage } from '../services/messageService.js';
import { registerBuiltInCommands } from '../services/commands/builtInCommands.js';
import { getCommandsForUser } from '../services/commands/registry.js';
import { objectIdSchema } from '../utils/validators.js';

const createBotSchema = z.object({
  name: z.string().trim().min(2).max(32),
  avatar: z.string().trim().url().max(500).nullable().optional().default(null),
  scopes: z
    .array(z.enum(['messages:write', 'messages:read', 'commands:register']))
    .min(1)
    .max(3)
    .optional()
    .default(['messages:write']),
});

const addBotToRoomSchema = z.object({
  botId: objectIdSchema,
});

const botPostMessageSchema = z.object({
  roomId: objectIdSchema,
  text: z.string().trim().min(1).max(2000),
});

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function createBotsRouter({ rateLimiter } = {}) {
  registerBuiltInCommands();
  const router = Router();
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  // GET /api/v1/commands — list slash commands available to the user
  router.get(
    '/commands',
    requireAuth,
    resolveWorkspace,
    asyncHandler(async (req, res) => {
      let room = null;
      if (req.query.roomId && mongoose.isValidObjectId(String(req.query.roomId))) {
        const access = await getRoomIfMember(String(req.query.roomId), req.user.id, {
          workspaceId: req.workspaceId,
        }).catch(() => null);
        room = access?.room || null;
      }
      const commands = getCommandsForUser(req.user, room);
      res.status(200).json({ commands });
    })
  );

  // POST /api/v1/workspaces/:id/bots — create a workspace-scoped bot
  router.post(
    '/workspaces/:id/bots',
    requireAuth,
    requireFeature('bots'),
    asyncHandler(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id)) {
        throw new AppError('Invalid workspace ID', 400);
      }
      const membership = await WorkspaceMember.findOne({
        workspace: req.params.id,
        user: req.user.id,
        status: 'active',
      }).lean();
      if (!membership) throw new AppError('Workspace not found', 404);
      assertCan(req.user, 'workspace.members.manage', { workspaceRole: membership.role });

      const parsed = createBotSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid bot payload', 400);
      }

      const { name, avatar, scopes } = parsed.data;
      const suffix = crypto.randomBytes(3).toString('hex');
      const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'bot';
      const botUsername = `${baseSlug}_${suffix}`.slice(0, 20);

      const botUser = await User.create({
        username: botUsername,
        usernameLower: botUsername.toLowerCase(),
        passwordHash: `!bot-no-login-${crypto.randomBytes(32).toString('hex')}`,
        isSystem: true,
        isBot: true,
      });

      const rawToken = `bot_${crypto.randomBytes(24).toString('hex')}`;
      const bot = await Bot.create({
        workspace: req.params.id,
        userId: botUser._id,
        name,
        username: botUsername,
        avatar,
        ownerId: req.user.id,
        scopes,
        tokenHash: hashToken(rawToken),
      });

      await audit('bot.created', {
        actor: req.user.id,
        targetType: 'Bot',
        targetId: bot._id.toString(),
        metadata: { workspaceId: req.params.id, name },
        ip: req.ip,
      });

      res.status(201).json({
        bot: {
          _id: bot._id.toString(),
          workspace: bot.workspace.toString(),
          userId: bot.userId.toString(),
          name: bot.name,
          username: bot.username,
          avatar: bot.avatar,
          scopes: bot.scopes,
          createdAt: bot.createdAt,
        },
        token: rawToken,
      });
    })
  );

  // GET /api/v1/workspaces/:id/bots — list workspace bots
  router.get(
    '/workspaces/:id/bots',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id)) {
        throw new AppError('Invalid workspace ID', 400);
      }
      const membership = await WorkspaceMember.findOne({
        workspace: req.params.id,
        user: req.user.id,
        status: 'active',
      }).lean();
      if (!membership) throw new AppError('Workspace not found', 404);
      assertCan(req.user, 'workspace.members.list', { workspaceRole: membership.role });

      const bots = await Bot.find(
        { workspace: req.params.id, disabledAt: null },
        { tokenHash: 0 }
      ).lean();

      res.status(200).json({ bots });
    })
  );

  // DELETE /api/v1/workspaces/:id/bots/:botId — disable a bot
  router.delete(
    '/workspaces/:id/bots/:botId',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.botId)) {
        throw new AppError('Invalid ID', 400);
      }
      const membership = await WorkspaceMember.findOne({
        workspace: req.params.id,
        user: req.user.id,
        status: 'active',
      }).lean();
      if (!membership) throw new AppError('Workspace not found', 404);
      assertCan(req.user, 'workspace.members.manage', { workspaceRole: membership.role });

      const bot = await Bot.findOneAndUpdate(
        { _id: req.params.botId, workspace: req.params.id, disabledAt: null },
        { $set: { disabledAt: new Date() } },
        { new: true }
      );
      if (!bot) throw new AppError('Bot not found', 404);

      await audit('bot.disabled', {
        actor: req.user.id,
        targetType: 'Bot',
        targetId: bot._id.toString(),
        ip: req.ip,
      });

      res.status(200).json({ ok: true });
    })
  );

  // POST /api/v1/rooms/:id/bots — add a workspace bot to a room
  router.post(
    '/rooms/:id/bots',
    requireAuth,
    resolveWorkspace,
    asyncHandler(async (req, res) => {
      const roomId = parseRoomId(req.params.id);
      const { room } = await getRoomIfMember(roomId, req.user.id, { workspaceId: req.workspaceId });
      assertCan(req.user, 'room.settings', { room });

      const parsed = addBotToRoomSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid botId', 400);
      }

      const bot = await Bot.findOne({
        _id: parsed.data.botId,
        workspace: req.workspaceId,
        disabledAt: null,
      }).lean();
      if (!bot) throw new AppError('Bot not found in this workspace', 404);

      await Room.updateOne(
        { _id: room._id, workspace: req.workspaceId },
        { $addToSet: { botIds: bot._id } }
      );
      await Room.updateOne(
        { _id: room._id, workspace: req.workspaceId, 'members.user': { $ne: bot.userId } },
        { $push: { members: { user: bot.userId, role: 'member' } } }
      );

      res.status(200).json({ ok: true, botId: bot._id.toString() });
    })
  );

  // POST /api/v1/bots/messages — post a message using a bot token
  router.post(
    '/bots/messages',
    requireFeature('bots'),
    asyncHandler(async (req, res) => {
      const authHeader = req.headers.authorization || '';
      const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!rawToken) throw new AppError('Missing bot token', 401);

      const bot = await Bot.findOne({ tokenHash: hashToken(rawToken), disabledAt: null }).lean();
      if (!bot) throw new AppError('Invalid or disabled bot token', 401);
      if (!bot.scopes.includes('messages:write')) {
        throw new AppError('Bot lacks messages:write scope', 403);
      }

      const parsed = botPostMessageSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid message payload', 400);
      }

      const room = await Room.findOne({
        _id: parsed.data.roomId,
        workspace: bot.workspace,
      }).lean();
      if (!room) throw new AppError('Room not found', 404);

      const isBotInRoom = (room.botIds || []).some((id) => id.toString() === bot._id.toString());
      if (!isBotInRoom) {
        throw new AppError('Bot must be added to this room before posting', 403);
      }

      const io = req.app.locals.io;
      const presence = req.app.locals.presence;
      const delivered = await deliverMessage({
        room,
        userId: bot.userId.toString(),
        username: bot.name,
        isBot: true,
        text: parsed.data.text,
        io,
        presence,
      });

      if (!delivered.ok) {
        throw new AppError(delivered.error || 'Failed to post bot message', 400);
      }

      res.status(201).json({ message: delivered.message });
    })
  );

  return router;
}
