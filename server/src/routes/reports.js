import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import Report from '../models/Report.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { createReportSchema, moderationActionSchema, objectIdSchema } from '../utils/validators.js';
import { getRoomIfMember } from '../services/roomAccess.js';
import { assertCan, can } from '../services/permissions.js';
import { revokeAllUserSessions } from '../services/sessionService.js';
import { audit } from '../services/auditService.js';
import { decryptField, encryptField } from '../services/cryptoService.js';
import env from '../config/env.js';

export function createReportsRouter({ rateLimiter, reportRateLimiter } = {}) {
  const router = Router();
  router.use(requireAuth);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  const postLimiter =
    reportRateLimiter ||
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: env.NODE_ENV === 'test' ? 200 : 15,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new AppError('Too many reports submitted. Try again later.', 429)),
    });

  // POST /api/reports — file a report against a message or user in a room
  router.post(
    '/',
    postLimiter,
    asyncHandler(async (req, res) => {
      const parsed = createReportSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid report payload', 400);
      }

      const { targetType, targetId, roomId, reason, note } = parsed.data;
      const { room } = await getRoomIfMember(roomId, req.user.id);

      let targetUser = null;
      let messageSnapshot = null;

      if (targetType === 'message') {
        const msg = await Message.findOne({ _id: targetId, room: room._id }).lean();
        if (!msg) {
          throw new AppError('Message not found in this room', 404);
        }
        targetUser = msg.sender;
        messageSnapshot = msg.deletedAt ? '[deleted]' : msg.text || '[attachment]';
      } else {
        const member = room.members.find((m) => m.user.toString() === targetId);
        if (!member) {
          throw new AppError('User is not a member of this room', 404);
        }
        targetUser = targetId;
      }

      const report = await Report.create({
        reporter: req.user.id,
        targetType,
        targetId,
        targetUser,
        roomId: room._id,
        reason,
        note: '',
        noteEnc: note ? encryptField(note) : null,
        messageSnapshot,
      });

      await audit('report.create', {
        actor: req.user.id,
        targetType: 'report',
        targetId: report._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { roomId: room._id.toString(), reason },
      });

      res.status(201).json({ report });
    })
  );

  // GET /api/reports — room moderators see room reports; global admins see all
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const dbUser = await User.findById(req.user.id, { globalRole: 1 }).lean();
      const isGlobalAdmin = can(dbUser, 'admin.audit.read');
      const filter = {};

      if (req.query.status && ['open', 'resolved', 'dismissed'].includes(String(req.query.status))) {
        filter.status = String(req.query.status);
      }

      if (req.query.roomId) {
        const parsedRoom = objectIdSchema.safeParse(String(req.query.roomId));
        if (!parsedRoom.success) {
          throw new AppError('Invalid room ID', 400);
        }
        if (!isGlobalAdmin) {
          const { room } = await getRoomIfMember(parsedRoom.data, req.user.id);
          assertCan(req.user, 'report.moderate', { room });
        }
        filter.roomId = parsedRoom.data;
      } else if (!isGlobalAdmin) {
        throw new AppError('roomId query parameter is required', 400);
      }

      const reports = await Report.find(filter)
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('reporter', 'username')
        .populate('targetUser', 'username')
        .lean();

      const decrypted = reports.map((r) => ({
        ...r,
        note: r.noteEnc ? decryptField(r.noteEnc) : r.note || '',
        noteEnc: undefined,
      }));

      res.status(200).json({ reports: decrypted });
    })
  );

  // POST /api/reports/:id/action — execute moderation action on a report
  router.post(
    '/:id/action',
    asyncHandler(async (req, res) => {
      const reportIdParsed = objectIdSchema.safeParse(req.params.id);
      if (!reportIdParsed.success) {
        throw new AppError('Invalid report ID', 400);
      }
      const parsed = moderationActionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid moderation action', 400);
      }

      const report = await Report.findById(reportIdParsed.data);
      if (!report) {
        throw new AppError('Report not found', 404);
      }

      const { action, note } = parsed.data;
      const dbUser = await User.findById(req.user.id, { globalRole: 1 }).lean();
      const isGlobalAdmin = can(dbUser, 'admin.audit.read');

      if (action === 'suspend') {
        if (!isGlobalAdmin) {
          throw new AppError('Global admin access required to suspend accounts', 403);
        }
      } else if (!isGlobalAdmin) {
        const { room } = await getRoomIfMember(report.roomId.toString(), req.user.id);
        assertCan(req.user, 'report.moderate', { room });
        if (action === 'ban') {
          assertCan(req.user, 'member.ban', { room });
        }
      }

      const io = req.app.locals.io;
      const roomIdStr = report.roomId.toString();
      const targetUserId = report.targetUser?.toString();

      if (action === 'delete_message' && report.targetType === 'message') {
        const msg = await Message.findById(report.targetId);
        if (msg && !msg.deletedAt) {
          msg.text = '';
          msg.deletedAt = new Date();
          msg.deletedBy = req.user.id;
          await msg.save();
          if (io) {
            io.to(`room:${roomIdStr}`).emit('message:deleted', {
              roomId: roomIdStr,
              messageId: msg._id.toString(),
              deletedAt: msg.deletedAt.toISOString(),
            });
          }
        }
      } else if (action === 'warn' && targetUserId && io) {
        io.to(`user:${targetUserId}`).emit('notification:notice', {
          type: 'moderation_warning',
          message: note || 'You have received a moderation warning.',
        });
      } else if (action === 'kick' && targetUserId) {
        await Room.updateOne({ _id: report.roomId }, { $pull: { members: { user: targetUserId } } });
        if (io) {
          io.in(`user:${targetUserId}`).socketsLeave(`room:${roomIdStr}`);
          io.to(`user:${targetUserId}`).emit('room:left', { roomId: roomIdStr });
          io.to(`room:${roomIdStr}`).emit('room:left', { roomId: roomIdStr, userId: targetUserId });
        }
      } else if (action === 'ban' && targetUserId) {
        await Room.updateOne(
          { _id: report.roomId },
          {
            $pull: { members: { user: targetUserId } },
            $push: {
              bannedUsers: {
                user: targetUserId,
                bannedBy: req.user.id,
                reason: note || report.reason,
                bannedAt: new Date(),
              },
            },
          }
        );
        await audit('room.ban', {
          actor: req.user.id,
          targetType: 'room',
          targetId: roomIdStr,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { bannedUserId: targetUserId, reason: report.reason },
        });
        if (io) {
          io.in(`user:${targetUserId}`).socketsLeave(`room:${roomIdStr}`);
          io.to(`user:${targetUserId}`).emit('room:left', { roomId: roomIdStr, banned: true });
          io.to(`room:${roomIdStr}`).emit('room:left', { roomId: roomIdStr, userId: targetUserId });
        }
      } else if (action === 'suspend' && targetUserId) {
        await User.updateOne(
          { _id: targetUserId },
          { $set: { suspendedAt: new Date(), suspensionReason: note || report.reason } }
        );
        const revokedIds = await revokeAllUserSessions(targetUserId, 'account_suspended');
        if (io) {
          for (const sid of revokedIds) {
            io.to(`session:${sid}`).emit('session:revoked', {
              reason: 'Your account has been suspended',
            });
            io.in(`session:${sid}`).disconnectSockets(true);
          }
        }
        await audit('user.suspend', {
          actor: req.user.id,
          targetType: 'user',
          targetId: targetUserId,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { reason: report.reason },
        });
      }

      report.status = action === 'dismiss' ? 'dismissed' : 'resolved';
      report.resolutionAction = action;
      report.resolvedBy = req.user.id;
      report.resolvedAt = new Date();
      report.resolutionNote = note || null;
      await report.save();

      await audit('report.resolved', {
        actor: req.user.id,
        targetType: 'report',
        targetId: report._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { action, roomId: roomIdStr },
      });

      res.status(200).json({ report });
    })
  );

  return router;
}
