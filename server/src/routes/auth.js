import { Router } from 'express';
import User from '../models/User.js';
import env from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { changePasswordSchema, registerSchema, loginSchema } from '../utils/validators.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { addUserToGeneralRoom } from '../services/roomMigration.js';
import { defaultPasswordService, getBackoffSeconds } from '../services/passwordService.js';
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
  }

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

      if (!user) {
        // Constant-time defense: run a full argon2 verification against a dummy hash
        // so response timing does not reveal whether a username exists.
        await passwordService.verifyDummyPassword(password);
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
      const { session, rawRefreshToken } = await createSession({
        userId: serializedUser.id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      const token = signToken({ ...serializedUser, sid: session._id.toString() });
      setRefreshCookie(res, rawRefreshToken);

      res.status(200).json({
        token,
        user: serializedUser,
      });
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

      res.status(200).json({ ok: true });
    })
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
      const result = await rotateRefreshToken(rawToken);

      if (result.status === 'reuse_detected') {
        clearRefreshCookie(res);
        disconnectSessionSockets(req.app.locals.io, result.revokedSessionIds);
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
    asyncHandler(async (req, res) => {
      const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
      const revoked = await revokeSessionByToken(rawToken, 'logout');
      clearRefreshCookie(res);

      if (revoked) {
        disconnectSessionSockets(req.app.locals.io, [revoked._id.toString()]);
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
      res.status(200).json({ ok: true, id: sid });
    })
  );

  return router;
}
