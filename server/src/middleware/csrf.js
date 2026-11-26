import crypto from 'node:crypto';
import env from '../config/env.js';
import { AppError } from './errorHandler.js';

export const CSRF_COOKIE_NAME = 'csrfToken';

function getCsrfCookieOptions() {
  const isProd = env.NODE_ENV === 'production';
  const sameSite = env.COOKIE_SAME_SITE || (isProd ? 'none' : 'lax');
  return {
    httpOnly: false,
    secure: isProd || sameSite === 'none',
    sameSite,
    path: '/api/auth',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

export function issueCsrfToken(res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE_NAME, token, getCsrfCookieOptions());
  return token;
}

/**
 * Multi-layer CSRF protection for cookie-authenticated routes (/api/auth/refresh, /api/auth/logout):
 * 1. Origin check against CLIENT_URL (when Origin header is present).
 * 2. Custom header check (X-Requested-With) blocking simple HTML form/CORS requests.
 * 3. Double-submit token comparison (cookie vs X-CSRF-Token header) using timingSafeEqual.
 *
 * Note: Routes authenticated solely via Authorization: Bearer <token> are not CSRF-able
 * because browsers never attach custom Authorization headers automatically.
 */
export function requireCsrf(req, _res, next) {
  const origin = req.headers.origin;
  if (origin && origin !== env.CLIENT_URL) {
    return next(new AppError('Invalid request origin', 403));
  }

  const requestedWith = req.headers['x-requested-with'];
  if (!requestedWith) {
    return next(new AppError('Missing custom request header', 403));
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers['x-csrf-token'];
  if (
    typeof cookieToken !== 'string' ||
    typeof headerToken !== 'string' ||
    cookieToken.length === 0 ||
    cookieToken.length !== headerToken.length
  ) {
    return next(new AppError('Invalid CSRF token', 403));
  }

  const valid = crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  if (!valid) {
    return next(new AppError('Invalid CSRF token', 403));
  }

  return next();
}
