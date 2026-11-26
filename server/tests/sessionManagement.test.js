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

describe('Sub-phase 8.2: Session Management & Live Revocation', () => {
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

  it('lists active sessions without token hashes and blocks IDOR revocation (404)', async () => {
    const { app } = await startServer();

    const alice = await request(app)
      .post('/api/auth/register')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0')
      .send({ username: 'Alice', password: 'password123' });

    const bob = await request(app)
      .post('/api/auth/register')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605.1.15')
      .send({ username: 'Bob', password: 'password123' });

    const aliceSessions = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${alice.body.token}`);

    expect(aliceSessions.status).toBe(200);
    expect(aliceSessions.body.sessions).toHaveLength(1);
    const s = aliceSessions.body.sessions[0];
    expect(s.isCurrent).toBe(true);
    expect(s.device).toContain('Chrome');
    expect(s.currentTokenHash).toBeUndefined();
    expect(s.previousTokenHash).toBeUndefined();

    // Bob cannot revoke Alice's session (404)
    const idorRevoke = await request(app)
      .delete(`/api/auth/sessions/${s.id}`)
      .set('Authorization', `Bearer ${bob.body.token}`);
    expect(idorRevoke.status).toBe(404);
  });

  it('immediately rejects next REST request and emits session:revoked to socket on revocation', async () => {
    const { app, url } = await startServer();

    const alice1 = await request(app)
      .post('/api/auth/register')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/125.0')
      .send({ username: 'Alice', password: 'password123' });

    const alice2 = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')
      .send({ username: 'Alice', password: 'password123' });

    const socket2 = createClient(url, {
      transports: ['websocket'],
      auth: { token: alice2.body.token },
    });
    socketsToClose.push(socket2);
    await new Promise((resolve) => socket2.once('connect', resolve));

    const revokedEventPromise = new Promise((resolve) => {
      socket2.once('session:revoked', resolve);
    });

    const listRes = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${alice1.body.token}`);
    expect(listRes.body.sessions).toHaveLength(2);
    const otherSession = listRes.body.sessions.find((s) => !s.isCurrent);
    expect(otherSession).toBeDefined();

    // Alice1 revokes Alice2's session
    const delRes = await request(app)
      .delete(`/api/auth/sessions/${otherSession.id}`)
      .set('Authorization', `Bearer ${alice1.body.token}`);
    expect(delRes.status).toBe(200);

    const revokedPayload = await revokedEventPromise;
    expect(revokedPayload.reason).toBeTruthy();

    // Alice2's next REST request immediately fails with 401
    const nextReq = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${alice2.body.token}`);
    expect(nextReq.status).toBe(401);
  });

  it('supports logging out everywhere else (keepCurrent: true) while keeping current session active', async () => {
    const { app } = await startServer();

    const s1 = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });
    const s2 = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Alice', password: 'password123' });

    const logoutOthers = await request(app)
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${s1.body.token}`)
      .send({ keepCurrent: true });
    expect(logoutOthers.status).toBe(200);

    // s1 still works
    const okReq = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${s1.body.token}`);
    expect(okReq.status).toBe(200);

    // s2 is revoked
    const deadReq = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${s2.body.token}`);
    expect(deadReq.status).toBe(401);
  });
});
