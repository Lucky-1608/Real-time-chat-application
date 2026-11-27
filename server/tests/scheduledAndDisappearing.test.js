import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { createStorageService } from '../src/services/storage.js';
import { createSchedulerService } from '../src/services/schedulerService.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import ScheduledMessage from '../src/models/ScheduledMessage.js';

describe('Sub-phase 9.2: Scheduled & Disappearing Messages', () => {
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
      ScheduledMessage.syncIndexes(),
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
      ScheduledMessage.deleteMany({}),
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

  function createMockStorage() {
    const deletedKeys = [];
    const objects = new Map();
    const mockS3 = {
      send: vi.fn(async (command) => {
        const name = command.constructor.name;
        const key = command.input.Key;
        if (name === 'HeadObjectCommand') {
          return { ContentLength: 512 };
        }
        if (name === 'DeleteObjectCommand') {
          deletedKeys.push(key);
          objects.delete(key);
          return {};
        }
        return {};
      }),
    };
    const mockPresigner = vi.fn(async (_c, cmd) => `https://mock-s3.local/${cmd.input.Key}`);
    return {
      storageService: createStorageService({
        s3Client: mockS3,
        presigner: mockPresigner,
        bucket: 'test-bucket',
      }),
      deletedKeys,
    };
  }

  async function startServer({ storageService } = {}) {
    const app = createApp({ storageService });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    const io = attachSockets(httpServer, app, { storageService });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, io, url: `http://127.0.0.1:${port}` };
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

  it('schedules, lists, cancels, delivers due/overdue messages once under concurrent claims, and re-checks permissions at send time', async () => {
    const { app, io, url } = await startServer();
    const owner = await registerUser(app, url, 'Owner');
    const member = await registerUser(app, url, 'Member');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'SchedRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${member.token}`);

    // Too soon (< 1 min) rejected
    const tooSoon = await request(app)
      .post(`/api/rooms/${roomId}/scheduled`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ text: 'Too early', sendAt: new Date(Date.now() + 10_000).toISOString() });
    expect(tooSoon.status).toBe(400);

    // Valid scheduled message 2 minutes from now
    const sendAt1 = new Date(Date.now() + 120_000);
    const sched1 = await request(app)
      .post(`/api/rooms/${roomId}/scheduled`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ text: 'Scheduled hello', sendAt: sendAt1.toISOString() });
    expect(sched1.status).toBe(201);

    // Second scheduled message that will be cancelled
    const sched2 = await request(app)
      .post(`/api/rooms/${roomId}/scheduled`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ text: 'Cancelled msg', sendAt: new Date(Date.now() + 180_000).toISOString() });
    expect(sched2.status).toBe(201);

    const listRes = await request(app)
      .get(`/api/rooms/${roomId}/scheduled`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(listRes.body.scheduled).toHaveLength(2);

    const cancelRes = await request(app)
      .delete(`/api/rooms/${roomId}/scheduled/${sched2.body.scheduled._id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(cancelRes.status).toBe(200);

    // Advance fake clock past sendAt1 and run two concurrent scheduler workers -> delivered ONCE!
    let fakeNow = new Date(sendAt1.getTime() + 5000);
    const schedulerA = createSchedulerService({ io, nowFn: () => fakeNow });
    const schedulerB = createSchedulerService({ io, nowFn: () => fakeNow });

    const [resA, resB] = await Promise.all([
      schedulerA.processNextScheduled(),
      schedulerB.processNextScheduled(),
    ]);
    expect([resA, resB].filter(Boolean)).toHaveLength(1);

    const msgs = await Message.find({ room: roomId }, null, { bypassTenantScope: true }).lean();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Scheduled hello');

    // Permission re-check at send time: enable announcementMode, schedule a third message as member (after turning off? or schedule before turning on)
    const sched3 = await request(app)
      .post(`/api/rooms/${roomId}/scheduled`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ text: 'Blocked by announcement', sendAt: new Date(Date.now() + 300_000).toISOString() });
    expect(sched3.status).toBe(201);

    await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ announcementMode: true });

    fakeNow = new Date(Date.now() + 400_000);
    await schedulerA.processNextScheduled();

    const failedJob = await ScheduledMessage.findById(sched3.body.scheduled._id).lean();
    expect(failedJob.status).toBe('failed');
    expect(await Message.countDocuments({ room: roomId }, { bypassTenantScope: true })).toBe(1);
  });

  it('filters expired disappearing messages on read, sweeps them with message:deleted, and cleans up attachments', async () => {
    const { storageService, deletedKeys } = createMockStorage();
    const { app, io, url } = await startServer({ storageService });
    const owner = await registerUser(app, url, 'Owner');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'EphemeralRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    // Enable 1h disappearing timer
    const patchRes = await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ disappearingTtlSeconds: 3600 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.room.disappearingTtlSeconds).toBe(3600);

    const presign = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ roomId, filename: 'temp.png', contentType: 'image/png', size: 512 });

    const ack = await new Promise((resolve) => {
      owner.socket.emit(
        'message:send',
        {
          roomId,
          text: 'Vanishing soon',
          attachments: [
            { key: presign.body.key, name: 'temp.png', contentType: 'image/png', size: 512 },
          ],
        },
        resolve
      );
    });
    expect(ack.ok).toBe(true);

    const created = await Message.findById(ack.id, null, { bypassTenantScope: true }).lean();
    expect(created.expiresAt).toBeTruthy();

    // Force expiresAt into the past -> read filtering hides it immediately
    await Message.updateOne(
      { _id: ack.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
      { bypassTenantScope: true }
    );

    const histRes = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(histRes.body.messages).toHaveLength(0);

    // Sweeper deletes the message, emits message:deleted, and deletes attachment from storage
    const deletedPromise = new Promise((resolve) => owner.socket.once('message:deleted', resolve));
    const scheduler = createSchedulerService({ io, storageService });
    await scheduler.sweepExpiredMessages();

    const delEvt = await deletedPromise;
    expect(delEvt.messageId).toBe(ack.id);
    expect(deletedKeys).toContain(presign.body.key);
    expect(await Message.findById(ack.id, null, { bypassTenantScope: true })).toBeNull();
  });
});
