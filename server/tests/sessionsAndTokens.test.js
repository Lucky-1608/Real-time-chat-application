import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import env from '../src/config/env.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Session from '../src/models/Session.js';

describe('Sub-phase 8.1: Access Tokens, Rotating Refresh Tokens & Sessions', () => {
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
    const app = createApp();
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, url: `http://127.0.0.1:${port}` };
  }

  function extractRefreshCookie(res) {
    const cookies = res.headers['set-cookie'] || [];
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
    return refreshCookie || '';
  }

  async function getCsrfContext(app) {
    const res = await request(app).get('/api/auth/csrf');
    const cookie = (res.headers['set-cookie'] || [])
      .find((c) => c.startsWith('csrfToken='))
      .split(';')[0];
    return {
      csrfToken: res.body.csrfToken,
      csrfCookie: cookie,
    };
  }

  function postWithCsrf(app, path, refreshCookie, csrf) {
    return request(app)
      .post(path)
      .set('Origin', 'http://localhost:5173')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-CSRF-Token', csrf.csrfToken)
      .set('Cookie', [refreshCookie, csrf.csrfCookie]);
  }

  it('sets httpOnly refresh cookie scoped to Path=/api/auth and returns 15m access token with sid', async () => {
    const { app } = await startServer();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });

    expect(reg.status).toBe(201);
    expect(typeof reg.body.token).toBe('string');
    expect(reg.body.refreshToken).toBeUndefined();

    const decoded = jwt.decode(reg.body.token);
    expect(decoded.sub).toBe(reg.body.user.id);
    expect(typeof decoded.sid).toBe('string');
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(15 * 60 + 5);

    const cookie = extractRefreshCookie(reg);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth');
  });

  it('rotates refresh token, supports 10s grace window, and revokes entire family on reuse outside grace window', async () => {
    const { app } = await startServer();
    const csrf = await getCsrfContext(app);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });

    const cookie1 = extractRefreshCookie(reg);
    const rawCookie1 = cookie1.split(';')[0];

    // First refresh rotates token -> cookie2
    const ref1 = await postWithCsrf(app, '/api/auth/refresh', rawCookie1, csrf);
    expect(ref1.status).toBe(200);
    expect(typeof ref1.body.token).toBe('string');
    const cookie2 = extractRefreshCookie(ref1).split(';')[0];
    expect(cookie2).not.toBe(rawCookie1);

    // Replaying cookie1 within grace window succeeds without rotating again
    const graceRes = await postWithCsrf(app, '/api/auth/refresh', rawCookie1, csrf);
    expect(graceRes.status).toBe(200);

    // Simulate grace window expiration by backdating rotatedAt on the Session
    await Session.updateMany({}, { $set: { rotatedAt: new Date(Date.now() - 20_000) } });

    // Replaying cookie1 outside grace window -> TOKEN REUSE -> revokes entire family (401)
    const reuseRes = await postWithCsrf(app, '/api/auth/refresh', rawCookie1, csrf);
    expect(reuseRes.status).toBe(401);

    // Even the legitimate cookie2 is now revoked
    const victimRes = await postWithCsrf(app, '/api/auth/refresh', cookie2, csrf);
    expect(victimRes.status).toBe(401);
  });

  it('handles concurrent refreshes safely without false-positive revocation', async () => {
    const { app } = await startServer();
    const csrf = await getCsrfContext(app);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });

    const rawCookie1 = extractRefreshCookie(reg).split(';')[0];

    const [r1, r2] = await Promise.all([
      postWithCsrf(app, '/api/auth/refresh', rawCookie1, csrf),
      postWithCsrf(app, '/api/auth/refresh', rawCookie1, csrf),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('rejects expired access tokens on REST and socket events, and accepts socket auth:refresh', async () => {
    const { app, url } = await startServer();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });

    const decoded = jwt.decode(reg.body.token);
    const expiredToken = jwt.sign(
      { sub: reg.body.user.id, username: 'Alice', sid: decoded.sid },
      env.JWT_SECRET,
      { expiresIn: -10 }
    );

    const restExpired = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(restExpired.status).toBe(401);

    // Connect with a short-lived 1s token, wait for expiry, verify event rejection + auth:expired
    const shortToken = jwt.sign(
      { sub: reg.body.user.id, username: 'Alice', sid: decoded.sid },
      env.JWT_SECRET,
      { expiresIn: 1 }
    );
    const socket = createClient(url, {
      transports: ['websocket'],
      auth: { token: shortToken },
    });
    socketsToClose.push(socket);
    await new Promise((resolve) => socket.once('connect', resolve));

    // Wait past 1s expiry + 5s grace? Wait: let's keep grace 0 or 1s? Let's test via backdating or waiting 2s if grace is 1s!
    // Actually, let's check socket.data.tokenExp: if we use 0s grace on expired check (now > tokenExp), waiting 1.2s works fast!
    await new Promise((r) => setTimeout(r, 2100));

    const expiredEventPromise = new Promise((resolve) => socket.once('auth:expired', resolve));
    const rooms = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${reg.body.token}`);
    const generalId = rooms.body.rooms[0]._id;

    const sendAck = await new Promise((resolve) => {
      socket.emit('message:send', { roomId: generalId, text: 'After expiry' }, resolve);
    });
    expect(sendAck.ok).toBe(false);
    await expiredEventPromise;

    // Refresh token over the same socket via auth:refresh
    const refreshAck = await new Promise((resolve) => {
      socket.emit('auth:refresh', { token: reg.body.token }, resolve);
    });
    expect(refreshAck.ok).toBe(true);

    const afterRefreshAck = await new Promise((resolve) => {
      socket.emit('message:send', { roomId: generalId, text: 'After refresh' }, resolve);
    });
    expect(afterRefreshAck.ok).toBe(true);
  });

  it('disconnects active sockets within 1 second when session is revoked via logout', async () => {
    const { app, url } = await startServer();
    const csrf = await getCsrfContext(app);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });
    const rawCookie = extractRefreshCookie(reg).split(';')[0];

    const socket = createClient(url, {
      transports: ['websocket'],
      auth: { token: reg.body.token },
    });
    socketsToClose.push(socket);
    await new Promise((resolve) => socket.once('connect', resolve));

    const disconnectedPromise = new Promise((resolve) => {
      socket.once('disconnect', () => resolve(Date.now()));
    });

    const start = Date.now();
    const logoutRes = await postWithCsrf(app, '/api/auth/logout', rawCookie, csrf);
    expect(logoutRes.status).toBe(200);

    const disconnectedAt = await disconnectedPromise;
    expect(disconnectedAt - start).toBeLessThan(1000);
  });
});
