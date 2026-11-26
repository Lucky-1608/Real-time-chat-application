import rateLimit from 'express-rate-limit';

/**
 * Creates a fresh rate-limiter instance per app so integration tests
 * have isolated counters and can verify 429 behavior deterministically.
 */
export function createAuthRateLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later' },
  });
}

export function createApiRateLimiter({ max = 200, windowMs = 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  });
}

export function createSummaryRateLimiter({ max = 5, windowMs = 60 * 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator: (req) => req.user?.id || req.ip,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Summary limit reached (max 5 per hour). Please try again later.' },
  });
}
