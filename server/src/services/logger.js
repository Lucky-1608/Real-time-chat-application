import crypto from 'node:crypto';
import pino from 'pino';
import env from '../config/env.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'refreshToken',
  'mfaToken',
  'secret',
  'text',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.text',
];

export function createLogger({
  level = env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug'),
  destination,
} = {}) {
  return pino(
    {
      level,
      redact: {
        paths: REDACT_PATHS,
        censor: '[Redacted]',
      },
      base: {
        service: 'pulsechat-api',
        env: env.NODE_ENV,
      },
    },
    destination
  );
}

export const logger = createLogger();

export function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingId)
      ? incomingId
      : crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  req.log = logger.child({ requestId });
  next();
}
