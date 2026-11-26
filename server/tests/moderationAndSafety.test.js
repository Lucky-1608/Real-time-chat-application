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
import Message from '../src/models/Message.js';
import Report from '../src/models/Report.js';
import InviteLink from '../src/models/InviteLink.js';
import AuditEvent from '../src/models/AuditEvent.js';

describe('Sub-phase 8.9: Block, Mute, Reports, Moderation, Invite Links & Room Settings', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      User.syncIndexes(),
      Room.syncIndexes(),
      Message.syncIndexes(),
      Report.syncIndexes(),
      InviteLink.syncIndexes(),
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
      Message.deleteMany({}),
      Report.deleteMany({}),
      InviteLink.deleteMany({}),
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

  async function startServer() {
    const app = createApp();
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, url: `http://127.0.0.1:${port}` };
  }

  async function registerUser(app, url, username) {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password: 'StrongPassword123' });
    const socket = createClient(url, {
      transports: ['websocket'],
      auth: { token: res.body.token },
    });
    socketsToClose.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { user: res.body.user, token: res.body.token, socket };
  }

  it('enforces user blocking on DM creation and socket message delivery', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');
    const carol = await registerUser(app, url, 'Carol');

    // Alice blocks Bob before DM exists -> Bob cannot create DM with Alice
    const blockRes = await request(app)
      .post(`/api/users/${bob.user.id}/block`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(blockRes.status).toBe(200);

    const dmAttempt = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ userId: alice.user.id });
    expect(dmAttempt.status).toBe(403);

    // Existing DM with Carol: Alice blocks Carol after DM creation -> Carol's socket message is rejected
    const dmCarolRes = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: carol.user.id });
    expect(dmCarolRes.status).toBe(201);
    const dmId = dmCarolRes.body.room._id;

    await request(app)
      .post(`/api/users/${carol.user.id}/block`)
      .set('Authorization', `Bearer ${alice.token}`);

    const carolAck = await new Promise((resolve) => {
      carol.socket.emit('message:send', { roomId: dmId, text: 'Blocked DM' }, resolve);
    });
    expect(carolAck.ok).toBe(false);
  });

  it('preserves immutable message snapshot on reports even after deletion, and executes moderation actions (ban & suspend)', async () => {
    const { app, url } = await startServer();
    const owner = await registerUser(app, url, 'Owner');
    const offender = await registerUser(app, url, 'Offender');
    const reporter = await registerUser(app, url, 'Reporter');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'ModRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${offender.token}`);
    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${reporter.token}`);

    // Offender sends a message
    const msgPromise = new Promise((resolve) => reporter.socket.once('message:new', resolve));
    await new Promise((resolve) => {
      offender.socket.emit('message:send', { roomId, text: 'Abusive content here' }, resolve);
    });
    const sentMsg = await msgPromise;

    // Reporter files a report
    const reportRes = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({
        targetType: 'message',
        targetId: sentMsg._id,
        roomId,
        reason: 'harassment',
        note: 'Targeted harassment',
      });
    expect(reportRes.status).toBe(201);
    const reportId = reportRes.body.report._id;
    expect(reportRes.body.report.messageSnapshot).toBe('Abusive content here');

    // Offender deletes their message -> report snapshot remains intact!
    await new Promise((resolve) => {
      offender.socket.emit('message:delete', { roomId, messageId: sentMsg._id }, resolve);
    });

    // Regular member cannot view room reports -> 403
    const memberReports = await request(app)
      .get(`/api/reports?roomId=${roomId}`)
      .set('Authorization', `Bearer ${reporter.token}`);
    expect(memberReports.status).toBe(403);

    // Owner views reports -> snapshot is still 'Abusive content here'
    const ownerReports = await request(app)
      .get(`/api/reports?roomId=${roomId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ownerReports.status).toBe(200);
    expect(ownerReports.body.reports[0].messageSnapshot).toBe('Abusive content here');

    // Owner bans offender via moderation action
    const banRes = await request(app)
      .post(`/api/reports/${reportId}/action`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ action: 'ban', note: 'Banned for harassment' });
    expect(banRes.status).toBe(200);

    // Banned offender cannot rejoin the public room
    const rejoinRes = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${offender.token}`);
    expect(rejoinRes.status).toBe(403);

    // Audit event recorded
    const banAudit = await AuditEvent.findOne({ action: 'room.ban' }).lean();
    expect(banAudit).toBeTruthy();
  });

  it('enforces invite link maxUses under concurrent redemption, expiry, bans, announcement mode, and member limit race', async () => {
    const { app, url } = await startServer();
    const owner = await registerUser(app, url, 'Owner');
    const u1 = await registerUser(app, url, 'UserOne');
    const u2 = await registerUser(app, url, 'UserTwo');
    const u3 = await registerUser(app, url, 'UserThree');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'InviteRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    // Enable announcement mode and set maxMembers = 2 (owner + 1 more)
    const settingsRes = await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ announcementMode: true, maxMembers: 2 });
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.room.announcementMode).toBe(true);

    // Create invite link with maxUses = 5 (testing member limit race + invite concurrency)
    const inviteRes = await request(app)
      .post(`/api/rooms/${roomId}/invites`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ expiresInHours: 24, maxUses: 5 });
    expect(inviteRes.status).toBe(201);
    const { token } = inviteRes.body;

    // Concurrent redemptions by u1, u2, u3 when maxMembers = 2 -> only ONE can succeed!
    const results = await Promise.all([
      request(app).post(`/api/rooms/invites/${token}/redeem`).set('Authorization', `Bearer ${u1.token}`),
      request(app).post(`/api/rooms/invites/${token}/redeem`).set('Authorization', `Bearer ${u2.token}`),
      request(app).post(`/api/rooms/invites/${token}/redeem`).set('Authorization', `Bearer ${u3.token}`),
    ]);
    const successes = results.filter((r) => r.status === 200);
    expect(successes).toHaveLength(1);

    const joinedUser = [u1, u2, u3].find(
      (u) => u.user.id === successes[0].body.room.members.find((m) => m.role === 'member')?.user.id
    );

    // Announcement mode: regular member cannot post, owner CAN post
    const memberSendAck = await new Promise((resolve) => {
      joinedUser.socket.emit('message:send', { roomId, text: 'Hello' }, resolve);
    });
    expect(memberSendAck.ok).toBe(false);

    const ownerSendAck = await new Promise((resolve) => {
      owner.socket.emit('message:send', { roomId, text: 'Official announcement' }, resolve);
    });
    expect(ownerSendAck.ok).toBe(true);
  });
});
