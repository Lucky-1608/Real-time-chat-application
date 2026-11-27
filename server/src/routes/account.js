import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import User from '../models/User.js';
import Room from '../models/Room.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import Message from '../models/Message.js';
import Session from '../models/Session.js';
import Report from '../models/Report.js';
import AuditEvent from '../models/AuditEvent.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { defaultPasswordService } from '../services/passwordService.js';
import { defaultStorageService, PRESIGN_GET_TTL_SECONDS } from '../services/storage.js';
import { revokeAllUserSessions } from '../services/sessionService.js';
import { decryptField } from '../services/cryptoService.js';
import {
  consumeRecoveryCode,
  verifyTotpWithReplayCheck,
} from '../services/twoFactorService.js';
import { audit } from '../services/auditService.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: z.string().trim().optional(),
  recoveryCode: z.string().trim().optional(),
});

export function createAccountRouter({
  rateLimiter,
  storageService = defaultStorageService,
  passwordService = defaultPasswordService,
} = {}) {
  const router = Router();
  router.use(requireAuth);
  if (rateLimiter) {
    router.use(rateLimiter);
  }

  // DELETE /api/account — immediate account deletion & anonymization
  // Trade-off: Immediate execution is chosen over a delayed cooling-off queue so
  // user erasure takes effect at once and cannot leave active sessions behind.
  // Messages are anonymized ("Deleted user") rather than hard-deleted so other
  // participants' conversation history remains coherent.
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = deleteAccountSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Password is required', 400);
      }

      const user = await User.findById(req.user.id);
      if (!user) throw new AppError('Unauthorized', 401);

      const { valid } = await passwordService.verifyPassword(parsed.data.password, user.passwordHash);
      if (!valid) {
        throw new AppError('Invalid password', 401);
      }

      if (user.twoFactorEnabled) {
        const { code, recoveryCode } = parsed.data;
        let mfaOk = false;
        if (code && user.twoFactorSecretEnc) {
          const secret = decryptField(user.twoFactorSecretEnc);
          const check = verifyTotpWithReplayCheck(secret, code, user.twoFactorLastStep);
          mfaOk = check.valid;
        } else if (recoveryCode) {
          mfaOk = await consumeRecoveryCode(user._id, recoveryCode);
        }
        if (!mfaOk) {
          throw new AppError('Valid 2FA verification code required', 401);
        }
      }

      const userId = user._id;
      const userIdStr = userId.toString();

      // 1. Delete uploaded objects belonging to this user's messages
      const userMsgsWithAttachments = await Message.find(
        { sender: userId, 'attachments.0': { $exists: true } },
        { attachments: 1 },
        { bypassTenantScope: true }
      ).lean();

      for (const msg of userMsgsWithAttachments) {
        for (const att of msg.attachments || []) {
          await storageService.deleteObject(att.key).catch(() => {});
        }
      }

      // 2. Anonymize messages (keep text/tombstones for other members' history)
      await Message.updateMany(
        { sender: userId },
        { $set: { senderName: 'Deleted user', attachments: [] } },
        { bypassTenantScope: true }
      );

      // 3. Remove from rooms; transfer ownership or delete empty/DM rooms
      const rooms = await Room.find({ 'members.user': userId }, null, { bypassTenantScope: true });
      for (const room of rooms) {
        const remaining = room.members.filter((m) => m.user.toString() !== userIdStr);
        if (room.type === 'dm' || (remaining.length === 0 && room.nameLower !== 'general')) {
          await Message.deleteMany({ workspace: room.workspace, room: room._id });
          await Room.deleteOne({ _id: room._id, workspace: room.workspace });
        } else {
          const wasOwner = room.members.some(
            (m) => m.user.toString() === userIdStr && m.role === 'owner'
          );
          const hasOtherOwner = remaining.some((m) => m.role === 'owner');
          room.members = remaining;
          if (wasOwner && !hasOtherOwner && remaining.length > 0) {
            const successor =
              remaining.find((m) => m.role === 'admin') ||
              remaining.find((m) => m.role === 'moderator') ||
              remaining[0];
            successor.role = 'owner';
          }
          await room.save();
        }
      }

      // 4. Purge PII from reports & prior audit events while preserving audit integrity
      await Report.updateMany(
        { reporter: userId },
        { $set: { note: '', noteEnc: null } }
      );
      await AuditEvent.updateMany(
        { actor: userId },
        { $set: { ip: null, userAgent: null } }
      );

      // 5. Revoke all sessions and disconnect sockets
      const revokedIds = await revokeAllUserSessions(userIdStr, 'account_deleted');
      const io = req.app.locals.io;
      if (io) {
        for (const sid of revokedIds) {
          io.to(`session:${sid}`).emit('session:revoked', { reason: 'Account deleted' });
          io.in(`session:${sid}`).disconnectSockets(true);
        }
      }

      await audit('account.delete', {
        actor: userId,
        targetType: 'user',
        targetId: userIdStr,
      });

      await Promise.all([
        WorkspaceMember.deleteMany({ user: userId }),
        Session.deleteMany({ user: userId }),
        User.deleteOne({ _id: userId }),
      ]);

      res.status(200).json({ ok: true });
    })
  );

  // POST /api/account/export — export only the requesting user's own data (1/day limit)
  router.post(
    '/export',
    asyncHandler(async (req, res) => {
      const user = await User.findById(req.user.id);
      if (!user) throw new AppError('Unauthorized', 401);

      if (user.lastExportAt && Date.now() - user.lastExportAt.getTime() < ONE_DAY_MS) {
        throw new AppError('Data export is limited to once every 24 hours', 429);
      }

      const [rooms, messages] = await Promise.all([
        Room.find(
          { 'members.user': user._id },
          { name: 1, type: 1, createdAt: 1 },
          { bypassTenantScope: true }
        ).lean(),
        Message.find(
          { sender: user._id },
          { room: 1, text: 1, createdAt: 1, editedAt: 1, deletedAt: 1, attachments: 1 },
          { bypassTenantScope: true }
        )
          .sort({ createdAt: 1 })
          .lean(),
      ]);

      const payload = {
        exportedAt: new Date().toISOString(),
        user: user.toJSON(),
        rooms: rooms.map((r) => ({
          id: r._id.toString(),
          name: r.name || 'Direct Message',
          type: r.type,
        })),
        messages: messages.map((m) => ({
          id: m._id.toString(),
          roomId: m.room.toString(),
          text: m.deletedAt ? '' : m.text,
          createdAt: m.createdAt,
          attachments: (m.attachments || []).map((a) => ({
            name: a.name,
            contentType: a.contentType,
            size: a.size,
          })),
        })),
      };

      user.lastExportAt = new Date();
      await user.save();

      await audit('account.export', {
        actor: user._id,
        targetType: 'user',
        targetId: user._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      if (storageService.isConfigured()) {
        const key = `exports/${user._id.toString()}/${crypto.randomUUID()}.json`;
        const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
        await storageService.putObjectBuffer({
          key,
          buffer,
          contentType: 'application/json',
        });
        const exportUrl = await storageService.createPresignedDownloadUrl({
          key,
          name: `pulsechat-export-${user.username}.json`,
          contentType: 'application/json',
        });
        return res.status(200).json({ exportUrl, expiresIn: PRESIGN_GET_TTL_SECONDS });
      }

      return res.status(200).json({ exportUrl: null, data: payload });
    })
  );

  return router;
}
