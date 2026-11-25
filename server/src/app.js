import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import env from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthRateLimiter } from './middleware/rateLimit.js';
import { createAuthRouter } from './routes/auth.js';
import { createMessagesRouter } from './routes/messages.js';

/**
 * Builds the Express application without binding a port so it can be
 * shared between the HTTP server bootstrap and Supertest integration tests.
 */
export function createApp({ registerRoutes, authRateLimiter } = {}) {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
  );
  // Cap JSON body size early to mitigate payload-flooding DoS attacks.
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.use(
    '/api/auth',
    createAuthRouter({ rateLimiter: authRateLimiter ?? createAuthRateLimiter() })
  );
  app.use('/api/messages', createMessagesRouter());

  if (typeof registerRoutes === 'function') {
    registerRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
