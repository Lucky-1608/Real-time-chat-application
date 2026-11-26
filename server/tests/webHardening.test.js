import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Session from '../src/models/Session.js';

describe('Sub-phase 8.5: Web, CSRF, NoSQL Injection & Socket Transport Hardening', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([User.syncIndexes(), Room.syncIndexes(), Session.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Room.deleteMany({}), Session.deleteMany({})]);
  });

  afterEach(async () => {
    for (const sock of socketsToClose.splice(0)) {
      if (sock.connected) sock.disconnect();
    }
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  async function startServer() {
    const app = createApp({ authRateLimiter: (_req, _res, next) => next() });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, url: `http://127.0.0.1:${port}` };
  }

  it('rejects CSRF attempts on cookie-authenticated routes (missing/wrong token or wrong Origin)', async () => {
    const { app } = await startServer();

    const csrfRes = await request(app).get('/api/auth/csrf');
    expect(csrfRes.status).toBe(200);
    const csrfToken = csrfRes.body.csrfToken;
    const csrfCookie = (csrfRes.headers['set-cookie'] || []).find((c) =>
      c.startsWith('csrfToken=')
    );
    expect(csrfCookie).toBeTruthy();

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'strong-password-10' });
    const refreshCookie = (reg.headers['set-cookie'] || [])
      .find((c) => c.startsWith('refreshToken='))
      .split(';')[0];

    // Missing CSRF token -> 403
    const noCsrf = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [refreshCookie, csrfCookie.split(';')[0]]);
    expect(noCsrf.status).toBe(403);

    // Wrong Origin -> 403
    const wrongOrigin = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', 'https://evil.example.com')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-CSRF-Token', csrfToken)
      .set('Cookie', [refreshCookie, csrfCookie.split(';')[0]]);
    expect(wrongOrigin.status).toBe(403);

    // Valid CSRF cookie + header + custom header + Origin -> 200
    const okRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', 'http://localhost:5173')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-CSRF-Token', csrfToken)
      .set('Cookie', [refreshCookie, csrfCookie.split(';')[0]]);
    expect(okRefresh.status).toBe(200);
  });

  it('blocks NoSQL injection operator payloads ({ $gt, $ne }) on auth and room routes', async () => {
    const { app } = await startServer();

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'strong-password-10' });

    const sqliLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: { $gt: '' }, password: { $ne: null } });
    expect(sqliLogin.status).toBe(400);

    const sqliRoom = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: { $ne: null }, type: 'public' });
    expect(sqliRoom.status).toBe(400);

    const sqliDm = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ userId: { $gt: '' } });
    expect(sqliDm.status).toBe(400);
  });

  it('rejects disallowed socket origins, unknown events, and oversized payloads', async () => {
    const { app, url } = await startServer();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'strong-password-10' });

    // Disallowed Origin rejected at handshake
    const badOriginSock = createClient(url, {
      transports: ['websocket'],
      auth: { token: reg.body.token },
      extraHeaders: { origin: 'https://attacker.example.com' },
    });
    socketsToClose.push(badOriginSock);
    const originErr = await new Promise((resolve) => badOriginSock.once('connect_error', resolve));
    expect(originErr).toBeTruthy();

    // Valid socket rejects unknown events and disconnects after repeat offenses
    const sock = createClient(url, {
      transports: ['websocket'],
      auth: { token: reg.body.token },
    });
    socketsToClose.push(sock);
    await new Promise((resolve) => sock.once('connect', resolve));

    const unknownAck = await new Promise((resolve) => {
      sock.emit('evil:unknown_event', { foo: 'bar' }, resolve);
    });
    expect(unknownAck.ok).toBe(false);

    const disconnectedPromise = new Promise((resolve) => sock.once('disconnect', resolve));
    sock.emit('evil:two', {});
    sock.emit('evil:three', {});
    await disconnectedPromise;
  });

  it('sets Helmet security headers and accepts /api/csp-report', async () => {
    const { app } = await startServer();
    const health = await request(app).get('/health');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

    const cspRes = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send({ 'csp-report': { 'violated-directive': 'script-src' } });
    expect(cspRes.status).toBe(204);
  });
});
