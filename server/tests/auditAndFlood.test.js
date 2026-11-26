import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { createFloodControl } from '../src/services/floodControl.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Session from '../src/models/Session.js';
import AuditEvent from '../src/models/AuditEvent.js';

describe('Sub-phase 8.6: Audit Log & Flood Control', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      User.syncIndexes(),
      Room.syncIndexes(),
      Session.syncIndexes(),
      AuditEvent.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Room.deleteMany({}),
      Session.deleteMany({}),
      AuditEvent.deleteMany({}),
    ]);
  });

  afterEach(async () => {
    for (const sock of socketsToClose.splice(0)) {
      if (sock.connected) sock.disconnect();
    }
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  async function startServer({ floodControl } = {}) {
    const app = createApp({ authRateLimiter: (_req, _res, next) => next(), floodControl });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app, { floodControl });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, url: `http://127.0.0.1:${port}` };
  }

  it('records single audit events without secrets and restricts GET /api/admin/audit to admins (403)', async () => {
    const { app } = await startServer();

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'strong-password-10' });
    const token = reg.body.token;

    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Alice', password: 'wrong-password-10' });

    const events = await AuditEvent.find({}).sort({ at: 1 }).lean();
    expect(events.map((e) => e.action)).toEqual(['auth.register', 'auth.login.failure']);

    // Ensure no secret or password fields leak into audit metadata
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('strong-password-10');
    expect(serialized).not.toContain('wrong-password-10');

    // Non-admin user receives 403 on GET /api/admin/audit
    const nonAdmin = await request(app)
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token}`);
    expect(nonAdmin.status).toBe(403);

    // Promote Alice to admin and query audit log
    await User.updateOne({ _id: reg.body.user.id }, { $set: { globalRole: 'admin' } });
    const adminRes = await request(app)
      .get('/api/admin/audit?action=auth.login.failure')
      .set('Authorization', `Bearer ${token}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.events).toHaveLength(1);
    expect(adminRes.body.events[0].action).toBe('auth.login.failure');
  });

  it('enforces room slow mode and duplicate-message spam heuristics', async () => {
    const { app, url } = await startServer();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'strong-password-10' });

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: 'SlowRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    // Enable 10s slow mode on the room
    await Room.updateOne({ _id: roomId }, { $set: { slowModeSeconds: 10 } });

    const sock = createClient(url, {
      transports: ['websocket'],
      auth: { token: reg.body.token },
    });
    socketsToClose.push(sock);
    await new Promise((resolve) => sock.once('connect', resolve));

    const first = await new Promise((resolve) => {
      sock.emit('message:send', { roomId, text: 'First message' }, resolve);
    });
    expect(first.ok).toBe(true);

    const secondSlow = await new Promise((resolve) => {
      sock.emit('message:send', { roomId, text: 'Second too fast' }, resolve);
    });
    expect(secondSlow.ok).toBe(false);
    expect(secondSlow.error).toMatch(/slow mode/i);

    // Disable slow mode and test duplicate-message spam (3 identical messages in window)
    await Room.updateOne({ _id: roomId }, { $set: { slowModeSeconds: 0 } });
    for (let i = 0; i < 3; i++) {
      const ok = await new Promise((resolve) => {
        sock.emit('message:send', { roomId, text: 'Buy cheap coins now!' }, resolve);
      });
      expect(ok.ok).toBe(true);
    }
    const spamBlocked = await new Promise((resolve) => {
      sock.emit('message:send', { roomId, text: 'Buy cheap coins now!' }, resolve);
    });
    expect(spamBlocked.ok).toBe(false);
    expect(spamBlocked.error).toMatch(/duplicate|spam/i);
  });

  it('enforces new-account restrictions on DMs and uploads during the restriction window', async () => {
    const strictFlood = createFloodControl({ newAccountMinutes: 15 });
    const { app } = await startServer({ floodControl: strictFlood });

    const alice = await request(app)
      .post('/api/auth/register')
      .send({ username: 'NewAlice', password: 'strong-password-10' });
    const bob = await request(app)
      .post('/api/auth/register')
      .send({ username: 'NewBob', password: 'strong-password-10' });

    const dmBlocked = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ userId: bob.body.user.id });
    expect(dmBlocked.status).toBe(403);

    const general = await Room.findOne({ nameLower: 'general', type: 'public' }).lean();
    const uploadBlocked = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({
        roomId: general._id.toString(),
        filename: 'pic.png',
        contentType: 'image/png',
        size: 1024,
      });
    expect(uploadBlocked.status).toBe(403);
  });
});
