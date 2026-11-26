import jwt from 'jsonwebtoken';
import env from '../config/env.js';
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

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Unauthorized', 401));
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    req.user = verifyToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}
