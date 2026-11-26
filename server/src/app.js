import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createApiRateLimiter, createAuthRateLimiter, createSummaryRateLimiter } from './middleware/rateLimit.js';
import { createAuthRouter } from './routes/auth.js';
import { createMessagesRouter } from './routes/messages.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createUsersRouter } from './routes/users.js';
import { createUploadsRouter } from './routes/uploads.js';
import { defaultStorageService } from './services/storage.js';
import { defaultSummaryService } from './services/summaryService.js';
import { defaultPasswordService } from './services/passwordService.js';

/**
 * Builds the Express application without binding a port so it can be
 * shared between the HTTP server bootstrap and Supertest integration tests.
 */
export function createApp({
  registerRoutes,
  authRateLimiter,
  apiRateLimiter,
  summaryRateLimiter,
  storageService = defaultStorageService,
  summaryService = defaultSummaryService,
  passwordService = defaultPasswordService,
} = {}) {
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
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  const sharedApiLimiter = apiRateLimiter ?? createApiRateLimiter();

  app.use(
    '/api/auth',
    createAuthRouter({
      rateLimiter: authRateLimiter ?? createAuthRateLimiter(),
      passwordService,
    })
  );
  app.use(
    '/api/rooms',
    createRoomsRouter({
      rateLimiter: sharedApiLimiter,
      summaryRateLimiter: summaryRateLimiter ?? createSummaryRateLimiter(),
      storageService,
      summaryService,
    })
  );
  app.use('/api/users', createUsersRouter({ rateLimiter: sharedApiLimiter }));
  app.use('/api/uploads', createUploadsRouter({ rateLimiter: sharedApiLimiter, storageService }));

  // Deprecated in favor of GET /api/rooms/:id/messages; kept for backward compatibility with General room clients.
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
