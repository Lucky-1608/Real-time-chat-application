import http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { parseEnv } from '../src/config/env.js';
import app, { createApp } from '../src/app.js';
import { asyncHandler } from '../src/utils/asyncHandler.js';
import { AppError } from '../src/middleware/errorHandler.js';
import { signToken } from '../src/middleware/auth.js';
import { attachSockets } from '../src/sockets/index.js';

describe('Phase 1: Server & WebSocket Foundation', () => {
  const serversToClose = [];
  const socketsToClose = [];

  afterEach(async () => {
    for (const sock of socketsToClose.splice(0)) {
      if (sock.connected) sock.disconnect();
    }
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  describe('Environment validation (parseEnv)', () => {
    it('fails when required variables are missing', () => {
      expect(() => parseEnv({})).toThrow(/Invalid environment configuration/);
    });

    it('fails when JWT_SECRET is shorter than 32 characters', () => {
      expect(() =>
        parseEnv({
          PORT: '4000',
          MONGO_URI: 'mongodb://localhost:27017/test',
          JWT_SECRET: 'too-short',
          CLIENT_URL: 'http://localhost:5173',
        })
      ).toThrow(/JWT_SECRET/);
    });

    it('parses valid environment configuration with defaults', () => {
      const parsed = parseEnv({
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'a'.repeat(32),
        CLIENT_URL: 'http://localhost:5173',
      });
      expect(parsed.PORT).toBe(4000);
      expect(parsed.NODE_ENV).toBe('development');
      expect(parsed.CLIENT_URL).toBe('http://localhost:5173');
    });
  });

  describe('Express app, helmet, health endpoint, and error handling', () => {
    it('GET /health returns 200 ok with helmet security headers', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns 404 JSON for unknown routes', async () => {
      const res = await request(app).get('/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Route not found/);
    });

    it('asyncHandler catches rejected promises and forwards to errorHandler', async () => {
      const testApp = createApp({
        registerRoutes: (instance) => {
          instance.get(
            '/boom-operational',
            asyncHandler(async () => {
              throw new AppError('Bad input', 400);
            })
          );
          instance.get(
            '/boom-unexpected',
            asyncHandler(async () => {
              throw new Error('Sensitive DB stack detail');
            })
          );
        },
      });

      const opRes = await request(testApp).get('/boom-operational');
      expect(opRes.status).toBe(400);
      expect(opRes.body).toEqual({ error: 'Bad input' });

      const unexpRes = await request(testApp).get('/boom-unexpected');
      expect(unexpRes.status).toBe(500);
      expect(unexpRes.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('Socket.io shared HTTP server', () => {
    it('connects two socket clients and round-trips a test event', async () => {
      const httpServer = http.createServer(app);
      serversToClose.push(httpServer);
      attachSockets(httpServer);

      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const { port } = httpServer.address();
      const url = `http://127.0.0.1:${port}`;

      const tokenA = signToken({
        id: '507f1f77bcf86cd799439011',
        username: 'alice',
        sid: '507f1f77bcf86cd799439021',
      });
      const tokenB = signToken({
        id: '507f1f77bcf86cd799439012',
        username: 'bob',
        sid: '507f1f77bcf86cd799439022',
      });

      const clientA = createClient(url, { transports: ['websocket'], auth: { token: tokenA } });
      const clientB = createClient(url, { transports: ['websocket'], auth: { token: tokenB } });
      socketsToClose.push(clientA, clientB);

      await Promise.all([
        new Promise((resolve, reject) => {
          clientA.on('connect', resolve);
          clientA.on('connect_error', reject);
        }),
        new Promise((resolve, reject) => {
          clientB.on('connect', resolve);
          clientB.on('connect_error', reject);
        }),
      ]);

      const receivedByB = new Promise((resolve) => {
        clientB.once('test:pong', resolve);
      });

      const ackResponse = await new Promise((resolve) => {
        clientA.emit('test:ping', { msg: 'hello-phase-1' }, resolve);
      });

      const broadcasted = await receivedByB;
      expect(ackResponse).toEqual({ ok: true, received: { msg: 'hello-phase-1' } });
      expect(broadcasted).toEqual({ msg: 'hello-phase-1' });
    });
  });
});
