import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import env from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { sanitizeNoSql } from './middleware/sanitize.js';
import { createApiRateLimiter, createAuthRateLimiter, createSummaryRateLimiter } from './middleware/rateLimit.js';
import { createAuthRouter } from './routes/auth.js';
import { createMessagesRouter } from './routes/messages.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createUsersRouter } from './routes/users.js';
import { createUploadsRouter } from './routes/uploads.js';
import { createAdminRouter } from './routes/admin.js';
import { createReportsRouter } from './routes/reports.js';
import { createAccountRouter } from './routes/account.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { createBotsRouter } from './routes/bots.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import { createSearchRouter } from './routes/search.js';
import { createAiRouter } from './routes/ai.js';
import { createCallsRouter } from './routes/calls.js';
import { ALLOWED_GIF_HOSTS } from './services/providers/gifProvider.js';
import { defaultStorageService } from './services/storage.js';
import { defaultSummaryService } from './services/summaryService.js';
import { defaultPasswordService } from './services/passwordService.js';
import { defaultFloodControl } from './services/floodControl.js';
import { requestIdMiddleware } from './services/logger.js';
import { httpDurationHistogram, register as metricsRegister } from './services/metricsService.js';
import { getFlags } from './services/featureFlags.js';
import { generateOpenApiDocument } from './services/openapi.js';
import { requireAdmin, requireAuth } from './middleware/auth.js';

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
  floodControl = defaultFloodControl,
  askLlmProvider,
} = {}) {
  mongoose.set('strictQuery', true);
  const app = express();
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const end = httpDurationHistogram.startTimer();
    res.on('finish', () => {
      end({
        method: req.method,
        route: req.route?.path || req.path || 'unknown',
        status: String(res.statusCode),
      });
    });
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          imgSrc: ["'self'", 'data:', ...ALLOWED_GIF_HOSTS.map((h) => `https://${h}`)],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      frameguard: { action: 'deny' },
    })
  );
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With', 'X-Workspace-Id'],
    })
  );
  app.use(
    ['/api/v1/hooks', '/api/hooks'],
    express.json({
      limit: '64kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  // Cap JSON body size early to mitigate payload-flooding DoS attacks.
  app.use(
    express.json({
      limit: '16kb',
      type: ['application/json', 'application/csp-report'],
    })
  );
  app.use(cookieParser());
  app.use(sanitizeNoSql);

  const cspReportLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post('/api/csp-report', cspReportLimiter, (req, res) => {
    const report = req.body?.['csp-report'] || req.body || {};
    console.warn('[csp-report]', {
      violatedDirective: report['violated-directive'] || report.effectiveDirective,
      blockedUri: report['blocked-uri'] || report.blockedURL,
    });
    res.status(204).end();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', (_req, res) => {
    const mongoReady = mongoose.connection.readyState === 1;
    if (!mongoReady) {
      return res.status(503).json({ status: 'not_ready', mongo: 'disconnected' });
    }
    return res.status(200).json({
      status: 'ready',
      mongo: 'connected',
      storage: storageService.isConfigured() ? 'configured' : 'disabled',
    });
  });

  app.get('/metrics', requireAuth, requireAdmin, async (_req, res) => {
    res.set('Content-Type', metricsRegister.contentType);
    res.status(200).send(await metricsRegister.metrics());
  });

  app.get('/api/v1/config', async (_req, res) => {
    const flags = await getFlags();
    res.status(200).json({ flags });
  });

  app.get('/api/config', async (_req, res) => {
    const flags = await getFlags();
    res.status(200).json({ flags });
  });

  const sharedApiLimiter = apiRateLimiter ?? createApiRateLimiter();
  const authRouter = createAuthRouter({
    rateLimiter: authRateLimiter ?? createAuthRateLimiter(),
    passwordService,
  });
  const roomsRouter = createRoomsRouter({
    rateLimiter: sharedApiLimiter,
    summaryRateLimiter: summaryRateLimiter ?? createSummaryRateLimiter(),
    storageService,
    summaryService,
    floodControl,
  });
  const usersRouter = createUsersRouter({ rateLimiter: sharedApiLimiter });
  const uploadsRouter = createUploadsRouter({
    rateLimiter: sharedApiLimiter,
    storageService,
    floodControl,
  });
  const adminRouter = createAdminRouter({ rateLimiter: sharedApiLimiter });
  const reportsRouter = createReportsRouter({ rateLimiter: sharedApiLimiter });
  const accountRouter = createAccountRouter({
    rateLimiter: sharedApiLimiter,
    storageService,
    passwordService,
  });
  const messagesRouter = createMessagesRouter();
  const workspacesRouter = createWorkspacesRouter({ rateLimiter: sharedApiLimiter });
  const botsRouter = createBotsRouter({ rateLimiter: sharedApiLimiter });
  const webhooksRouter = createWebhooksRouter({ rateLimiter: sharedApiLimiter });
  const searchRouter = createSearchRouter({ rateLimiter: sharedApiLimiter });
  const aiRouter = createAiRouter({ rateLimiter: sharedApiLimiter, askLlmProvider });
  const callsRouter = createCallsRouter({ rateLimiter: sharedApiLimiter });

  const openApiDoc = generateOpenApiDocument();
  const docsMiddlewares = env.NODE_ENV === 'production' ? [requireAuth, requireAdmin] : [];
  app.use('/api/docs', ...docsMiddlewares, swaggerUi.serve, swaggerUi.setup(openApiDoc));

  // Primary versioned API routes (/api/v1/*)
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/workspaces', workspacesRouter);
  app.use('/api/v1/rooms', roomsRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/uploads', uploadsRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/account', accountRouter);
  app.use('/api/v1/messages', messagesRouter);
  app.use('/api/v1', botsRouter);
  app.use('/api/v1', webhooksRouter);
  app.use('/api/v1/search', searchRouter);
  app.use('/api/v1/ai', aiRouter);
  app.use('/api/v1/calls', callsRouter);

  // Legacy /api/* aliases with Deprecation header for one release
  const deprecateLegacyApi = (_req, res, next) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/v1>; rel="successor-version"');
    next();
  };
  app.use('/api/auth', deprecateLegacyApi, authRouter);
  app.use('/api/workspaces', deprecateLegacyApi, workspacesRouter);
  app.use('/api/rooms', deprecateLegacyApi, roomsRouter);
  app.use('/api/users', deprecateLegacyApi, usersRouter);
  app.use('/api/uploads', deprecateLegacyApi, uploadsRouter);
  app.use('/api/admin', deprecateLegacyApi, adminRouter);
  app.use('/api/reports', deprecateLegacyApi, reportsRouter);
  app.use('/api/account', deprecateLegacyApi, accountRouter);
  app.use('/api/messages', deprecateLegacyApi, messagesRouter);
  app.use('/api', deprecateLegacyApi, botsRouter);
  app.use('/api', deprecateLegacyApi, webhooksRouter);
  app.use('/api/search', deprecateLegacyApi, searchRouter);
  app.use('/api/ai', deprecateLegacyApi, aiRouter);
  app.use('/api/calls', deprecateLegacyApi, callsRouter);

  if (typeof registerRoutes === 'function') {
    registerRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
