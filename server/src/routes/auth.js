import { Router } from 'express';
import User from '../models/User.js';
import env from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  changePasswordSchema,
  registerSchema,
  loginSchema,
  twoFactorCodeSchema,
  twoFactorDisableSchema,
  twoFactorVerifySchema,
} from '../utils/validators.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { issueCsrfToken, requireCsrf } from '../middleware/csrf.js';
import { addUserToGeneralRoom } from '../services/roomMigration.js';
import { defaultPasswordService, getBackoffSeconds } from '../services/passwordService.js';
import { decryptField, encryptField } from '../services/cryptoService.js';
import { audit } from '../services/auditService.js';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSetup,
  signMfaPendingToken,
  verifyMfaPendingToken,
  verifyTotpWithReplayCheck,
} from '../services/twoFactorService.js';
import {
  createSession,
  listUserSessions,
  revokeAllUserSessions,
  revokeSessionByToken,
  revokeUserSessionById,
  rotateRefreshToken,
} from '../services/sessionService.js';

const REFRESH_COOKIE_NAME = 'refreshToken';

function getCookieOptions() {
  const isProd = env.NODE_ENV === 'production';
  // Cross-site client (Vercel/Netlify) + API (Render/Railway) requires SameSite=None; Secure in production.
  // Local http://localhost dev/test uses SameSite=Lax without Secure so cookies work over plain HTTP.
  const sameSite = env.COOKIE_SAME_SITE || (isProd ? 'none' : 'lax');
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
}

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, getCookieOptions());
}

function clearRefreshCookie(res) {
  const opts = getCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
  });
}

function disconnectSessionSockets(io, sessionIds, reason = 'Session revoked') {
  if (!io || !Array.isArray(sessionIds)) return;
  for (const sid of sessionIds) {
    io.to(`session:${sid}`).emit('session:revoked', { reason });
    io.in(`session:${sid}`).disconnectSockets(true);
  }
}

export function createAuthRouter({ rateLimiter, passwordService = defaultPasswordService } = {}) {
  const router = Router();

  if (rateLimiter) {
    router.use('/register', rateLimiter);
    router.use('/login', rateLimiter);
    router.use('/2fa/verify', rateLimiter);
  }

  router.get('/csrf', (_req, res) => {
    const csrfToken = issueCsrfToken(res);
    res.status(200).json({ csrfToken });
  });

  // Trade-off: In a public chat app usernames are visible in rooms, so registration
  // returns 409 when a username is taken; timing is kept consistent via argon2id hashing only after check.
  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid registration data', 400);
      }

      const { username, password } = parsed.data;
      const usernameLower = username.toLowerCase();

      const existing = await User.findOne({ usernameLower }).lean();
      if (existing) {
        throw new AppError('Username is already taken', 409);
      }

      await passwordService.ensureNotBreached(password);

      const passwordHash = await passwordService.hashPassword(password);
      const user = await User.create({
        username,
        usernameLower,
        passwordHash,
      });

      await addUserToGeneralRoom(user._id);

      const serializedUser = user.toJSON();
      const { session, rawRefreshToken } = await createSession({
        userId: serializedUser.id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      const token = signToken({ ...serializedUser, sid: session._id.toString() });
      setRefreshCookie(res, rawRefreshToken);

      await audit('auth.register', {
        actor: serializedUser.id,
        targetType: 'user',
        targetId: serializedUser.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      res.status(201).json({
        token,
        user: serializedUser,
      });
    })
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid login data', 400);
      }

      const { username, password } = parsed.data;
      const usernameLower = username.toLowerCase();

      const user = await User.findOne({ usernameLower });

      if (!user || user.isSystem) {
        // Constant-time defense: run a full argon2 verification against a dummy hash
        // so response timing does not reveal whether a username exists (or is a system bot).
        await passwordService.verifyDummyPassword(password);
        await audit('auth.login.failure', {
          targetType: 'user',
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { reason: 'invalid_credentials' },
        });
        throw new AppError('Invalid username or password', 401);
      }

      const now = Date.now();
      // Exponential delay instead of a permanent hard lock: prevents an attacker from
      // permanently locking out a victim (lockout-DoS) while slowing brute-force across IPs.
      if (user.loginLockedUntil && user.loginLockedUntil.getTime() > now) {
        await passwordService.verifyDummyPassword(password);
        const retryAfterSec = Math.max(
          1,
          Math.ceil((user.loginLockedUntil.getTime() - now) / 1000)
        );
        res.set('Retry-After', String(retryAfterSec));
        await audit('auth.login.failure', {
          actor: user._id,
          targetType: 'user',
          targetId: user._id.toString(),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { reason: 'account_locked' },
        });
        throw new AppError('Invalid username or password', 401);
      }

      const { valid, needsRehash } = await passwordService.verifyPassword(
        password,
        user.passwordHash
      );

      if (!valid) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        const backoffSec = getBackoffSeconds(user.failedLoginAttempts);
        if (backoffSec > 0) {
          user.loginLockedUntil = new Date(now + backoffSec * 1000);
          res.set('Retry-After', String(backoffSec));
        }
        await user.save();
        await audit('auth.login.failure', {
          actor: user._id,
          targetType: 'user',
          targetId: user._id.toString(),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { reason: 'invalid_credentials', attempts: user.failedLoginAttempts },
        });
        throw new AppError('Invalid username or password', 401);
      }

      // Reset failure counters and transparently upgrade legacy bcrypt hashes to argon2id.
      let dirty = false;
      if (user.failedLoginAttempts > 0 || user.loginLockedUntil) {
        user.failedLoginAttempts = 0;
        user.loginLockedUntil = null;
        dirty = true;
      }
      if (needsRehash) {
        user.passwordHash = await passwordService.hashPassword(password);
        dirty = true;
      }
      if (dirty) {
        await user.save();
      }

      const serializedUser = user.toJSON();

      // If 2FA is enabled, return a short-lived single-purpose pending token instead of a session.
      if (user.twoFactorEnabled) {
        return res.status(200).json({
          mfaRequired: true,
          mfaToken: signMfaPendingToken(serializedUser.id),
        });
      }

      const { session, rawRefreshToken } = await createSession({
        userId: serializedUser.id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      const token = signToken({ ...serializedUser, sid: session._id.toString() });
      setRefreshCookie(res, rawRefreshToken);

      await audit('auth.login.success', {
        actor: serializedUser.id,
        targetType: 'session',
        targetId: session._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      res.status(200).json({
        token,
        user: serializedUser,
      });
    })
  );

  router.post(
    '/2fa/setup',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await User.findById(req.user.id);
      if (!user) throw new AppError('Unauthorized', 401);

      const { secret, otpauthUri, qrDataUrl } = await generateTotpSetup(user.username);
      user.twoFactorPendingSecretEnc = encryptField(secret);
      await user.save();

      res.status(200).json({ otpauthUri, qrDataUrl, secret });
    })
  );

  router.post(
    '/2fa/enable',
    requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = twoFactorCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid code', 400);
      }

      const user = await User.findById(req.user.id);
      if (!user || !user.twoFactorPendingSecretEnc) {
        throw new AppError('Start 2FA setup first', 400);
      }

      const secret = decryptField(user.twoFactorPendingSecretEnc);
      const check = verifyTotpWithReplayCheck(secret, parsed.data.code, null);
      if (!check.valid) {
        throw new AppError('Invalid verification code', 400);
      }

      const { plaintextCodes, hashedEntries } = generateRecoveryCodes();
      user.twoFactorEnabled = true;
      user.twoFactorSecretEnc = user.twoFactorPendingSecretEnc;
      user.twoFactorPendingSecretEnc = null;
      user.twoFactorLastStep = check.step;
      user.recoveryCodeHashes = hashedEntries;
      await user.save();

      const revokedIds = await revokeAllUserSessions(req.user.id, '2fa_enabled', {
        exceptSessionId: req.user.sid,
      });
      disconnectSessionSockets(req.app.locals.io, revokedIds, 'Two-factor authentication enabled');
      await audit('auth.2fa.enable', {
        actor: req.user.id,
        targetType: 'user',
        targetId: req.user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      res.status(200).json({ ok: true, recoveryCodes: plaintextCodes });
    })
  );

  router.post(
    '/2fa/verify',
    asyncHandler(async (req, res) => {
      const parsed = twoFactorVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid MFA payload', 400);
      }

      const { mfaToken, code, recoveryCode } = parsed.data;
      const { userId } = verifyMfaPendingToken(mfaToken);
      const user = await User.findById(userId);
      if (!user || !user.twoFactorEnabled || !user.twoFactorSecretEnc) {
        throw new AppError('Invalid or expired MFA session', 401);
      }

      const now = Date.now();
      if (user.loginLockedUntil && user.loginLockedUntil.getTime() > now) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((user.loginLockedUntil.getTime() - now) / 1000)
        );
        res.set('Retry-After', String(retryAfterSec));
        throw new AppError('Invalid verification code', 401);
      }

      let verified = false;
      let acceptedStep = null;

      if (code) {
        const secret = decryptField(user.twoFactorSecretEnc);
        const check = verifyTotpWithReplayCheck(secret, code, user.twoFactorLastStep);
        if (check.valid) {
          verified = true;
          acceptedStep = check.step;
        }
      } else if (recoveryCode) {
        verified = await consumeRecoveryCode(user._id, recoveryCode);
        if (verified) {
          await audit('auth.2fa.recovery_used', {
            actor: user._id,
            targetType: 'user',
            targetId: user._id.toString(),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            requestId: req.id,
          });
        }
      }

      if (!verified) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        const backoffSec = getBackoffSeconds(user.failedLoginAttempts);
        if (backoffSec > 0) {
          user.loginLockedUntil = new Date(now + backoffSec * 1000);
          res.set('Retry-After', String(backoffSec));
        }
        await user.save();
        await audit('auth.login.failure', {
          actor: user._id,
          targetType: 'user',
          targetId: user._id.toString(),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { reason: 'invalid_mfa' },
        });
        throw new AppError('Invalid verification code', 401);
      }

      user.failedLoginAttempts = 0;
      user.loginLockedUntil = null;
      if (acceptedStep !== null) {
        user.twoFactorLastStep = acceptedStep;
      }
      await user.save();

      const serializedUser = user.toJSON();
      const { session, rawRefreshToken } = await createSession({
        userId: serializedUser.id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      const token = signToken({ ...serializedUser, sid: session._id.toString() });
      setRefreshCookie(res, rawRefreshToken);

      await audit('auth.login.success', {
        actor: serializedUser.id,
        targetType: 'session',
        targetId: session._id.toString(),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { mfa: true },
      });

      res.status(200).json({ token, user: serializedUser });
    })
  );

  router.post(
    '/2fa/disable',
    requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = twoFactorDisableSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid disable payload', 400);
      }

      const user = await User.findById(req.user.id);
      if (!user || !user.twoFactorEnabled || !user.twoFactorSecretEnc) {
        throw new AppError('Two-factor authentication is not enabled', 400);
      }

      const { valid } = await passwordService.verifyPassword(parsed.data.password, user.passwordHash);
      if (!valid) {
        throw new AppError('Current password is incorrect', 401);
      }

      const secret = decryptField(user.twoFactorSecretEnc);
      const check = verifyTotpWithReplayCheck(secret, parsed.data.code, user.twoFactorLastStep);
      if (!check.valid) {
        throw new AppError('Invalid verification code', 401);
      }

      user.twoFactorEnabled = false;
      user.twoFactorSecretEnc = null;
      user.twoFactorPendingSecretEnc = null;
      user.twoFactorLastStep = check.step;
      user.recoveryCodeHashes = [];
      await user.save();

      const revokedIds = await revokeAllUserSessions(req.user.id, '2fa_disabled', {
        exceptSessionId: req.user.sid,
      });
      disconnectSessionSockets(req.app.locals.io, revokedIds, 'Two-factor authentication disabled');
      await audit('auth.2fa.disable', {
        actor: req.user.id,
        targetType: 'user',
        targetId: req.user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      res.status(200).json({ ok: true });
    })
  );

  router.post(
    '/change-password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid password data', 400);
      }

      const { currentPassword, newPassword } = parsed.data;
      const user = await User.findById(req.user.id);
      if (!user) {
        throw new AppError('Unauthorized', 401);
      }

      const { valid } = await passwordService.verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        throw new AppError('Current password is incorrect', 401);
      }

      await passwordService.ensureNotBreached(newPassword);

      user.passwordHash = await passwordService.hashPassword(newPassword);
      user.failedLoginAttempts = 0;
      user.loginLockedUntil = null;
      await user.save();

      const revokedIds = await revokeAllUserSessions(req.user.id, 'password_change', {
        exceptSessionId: req.user.sid,
      });
      disconnectSessionSockets(req.app.locals.io, revokedIds, 'Password changed on another device');

      await audit('auth.password_change', {
        actor: req.user.id,
        targetType: 'user',
        targetId: req.user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });

      res.status(200).json({ ok: true });
    })
  );

  router.post(
    '/refresh',
    requireCsrf,
    asyncHandler(async (req, res) => {
      const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
      const result = await rotateRefreshToken(rawToken);

      if (result.status === 'reuse_detected') {
        clearRefreshCookie(res);
        disconnectSessionSockets(req.app.locals.io, result.revokedSessionIds);
        await audit('auth.token_reuse', {
          targetType: 'session',
          targetId: result.revokedSessionIds?.[0] || null,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
          metadata: { revokedCount: result.revokedSessionIds?.length || 0 },
        });
        throw new AppError('Session expired. Please sign in again.', 401);
      }

      if (result.status === 'invalid') {
        clearRefreshCookie(res);
        throw new AppError('Invalid or expired refresh token', 401);
      }

      const user = await User.findById(result.session.user);
      if (!user) {
        clearRefreshCookie(res);
        throw new AppError('Unauthorized', 401);
      }

      if (result.status === 'rotated') {
        setRefreshCookie(res, result.rawRefreshToken);
      }

      const serializedUser = user.toJSON();
      const token = signToken({ ...serializedUser, sid: result.session._id.toString() });

      res.status(200).json({
        token,
        user: serializedUser,
      });
    })
  );

  router.post(
    '/logout',
    requireCsrf,
    asyncHandler(async (req, res) => {
      const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
      const revoked = await revokeSessionByToken(rawToken, 'logout');
      clearRefreshCookie(res);

      if (revoked) {
        disconnectSessionSockets(req.app.locals.io, [revoked._id.toString()]);
        await audit('auth.logout', {
          actor: revoked.user,
          targetType: 'session',
          targetId: revoked._id.toString(),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
        });
      }

      res.status(200).json({ ok: true });
    })
  );

  router.post(
    '/logout-all',
    requireAuth,
    asyncHandler(async (req, res) => {
      const keepCurrent = Boolean(req.body?.keepCurrent);
      const revokedIds = await revokeAllUserSessions(req.user.id, 'logout_all', {
        exceptSessionId: keepCurrent ? req.user.sid : undefined,
      });
      if (!keepCurrent) {
        clearRefreshCookie(res);
      }
      disconnectSessionSockets(req.app.locals.io, revokedIds, 'Signed out from all devices');
      await audit('auth.logout_all', {
        actor: req.user.id,
        targetType: 'user',
        targetId: req.user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        metadata: { keepCurrent, revokedCount: revokedIds.length },
      });
      res.status(200).json({ ok: true });
    })
  );

  router.get(
    '/sessions',
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessions = await listUserSessions(req.user.id, req.user.sid);
      res.status(200).json({ sessions });
    })
  );

  router.delete(
    '/sessions/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const revoked = await revokeUserSessionById(req.params.id, req.user.id, 'revoked_by_user');
      if (!revoked) {
        throw new AppError('Session not found', 404);
      }
      const sid = revoked._id.toString();
      if (sid === req.user.sid) {
        clearRefreshCookie(res);
      }
      disconnectSessionSockets(req.app.locals.io, [sid], 'You were signed out');
      await audit('auth.session.revoke', {
        actor: req.user.id,
        targetType: 'session',
        targetId: sid,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
      });
      res.status(200).json({ ok: true, id: sid });
    })
  );

  return router;
}
