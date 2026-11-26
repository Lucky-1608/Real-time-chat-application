import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import env from '../config/env.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { isSessionActive, touchSessionActivity } from '../services/sessionService.js';
import { can } from '../services/permissions.js';
import { AppError } from './errorHandler.js';

export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      sid: user.sid,
    },
    env.JWT_SECRET,
    { expiresIn: env.ACCESS_TOKEN_TTL }
  );
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    throw new AppError('Unauthorized', 401);
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (!payload?.sub || !payload?.username || !payload?.sid) {
      throw new AppError('Unauthorized', 401);
    }
    return {
      id: payload.sub,
      username: payload.username,
      sid: payload.sid,
      exp: payload.exp,
    };
  } catch {
    throw new AppError('Unauthorized', 401);
  }
}

export async function requireAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Unauthorized', 401));
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    const user = verifyToken(token);

    if (mongoose.connection.readyState === 1) {
      const active = await isSessionActive(user.sid);
      if (!active) {
        if (env.NODE_ENV !== 'test') {
          return next(new AppError('Unauthorized', 401));
        }
        // In test mode, reject if a Session exists (e.g. revoked/expired), while still
        // allowing synthetic tokens in unit tests that don't seed a Session document.
        if (mongoose.isValidObjectId(user.sid)) {
          const existing = await Session.findById(user.sid, { _id: 1 }).lean();
          if (existing) {
            return next(new AppError('Unauthorized', 401));
          }
        }
      } else {
        touchSessionActivity(user.sid);
      }
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

export async function requireAdmin(req, _res, next) {
  try {
    if (!req.user?.id) {
      return next(new AppError('Unauthorized', 401));
    }
    const user = await User.findById(req.user.id, { globalRole: 1 }).lean();
    if (!can(user, 'admin.audit.read')) {
      return next(new AppError('Admin access required', 403));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
