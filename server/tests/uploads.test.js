import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { createStorageService, MAX_UPLOAD_BYTES } from '../src/services/storage.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';

describe('Sub-phase 7.3: Presigned S3/R2 Uploads & Attachment Security', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([User.syncIndexes(), Room.syncIndexes(), Message.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Room.deleteMany({}), Message.deleteMany({})]);
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
    const mockS3 = {
      send: vi.fn(async () => ({ ContentLength: 1024 })),
    };
    const mockPresigner = vi.fn(async (_client, command) => {
      const key = command.input.Key;
      const isPut = command.constructor.name === 'PutObjectCommand';
      return `https://mock-s3.local/${isPut ? 'put' : 'get'}/${key}`;
    });
    return createStorageService({
      s3Client: mockS3,
      presigner: mockPresigner,
      bucket: 'test-bucket',
    });
  }

  async function startServerWithMockStorage() {
    const storageService = createMockStorage();
    const app = createApp({ storageService });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app, { storageService });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, url: `http://127.0.0.1:${port}` };
  }

  async function registerAndConnect(app, url, username) {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password: 'password123' });
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

  it('validates presign type (rejects SVG), size (>10MB), and room membership', async () => {
    const { app, url } = await startServerWithMockStorage();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'FilesRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    // SVG rejected (XSS risk)
    const svgRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ roomId, filename: 'evil.svg', contentType: 'image/svg+xml', size: 500 });
    expect(svgRes.status).toBe(400);

    // Oversized file rejected
    const bigRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        roomId,
        filename: 'huge.png',
        contentType: 'image/png',
        size: MAX_UPLOAD_BYTES + 1,
      });
    expect(bigRes.status).toBe(400);

    // Non-member rejected (404 for private room)
    const outsiderRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ roomId, filename: 'photo.png', contentType: 'image/png', size: 1024 });
    expect(outsiderRes.status).toBe(404);

    // Valid member gets presigned PUT URL and random UUID key under quarantine/<roomId>/
    const okRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ roomId, filename: 'my secret photo.png', contentType: 'image/png', size: 1024 });
    expect(okRes.status).toBe(200);
    expect(okRes.body.key).toMatch(new RegExp(`^quarantine/${roomId}/[0-9a-f-]+\\.png$`));
    expect(okRes.body.uploadUrl).toContain(okRes.body.key);
  });

  it('enforces attachment key prefix per room and supports attachment-only messages with presigned GET URLs', async () => {
    const { app, url } = await startServerWithMockStorage();
    const alice = await registerAndConnect(app, url, 'Alice');

    const roomA = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'RoomOne', type: 'private' });
    const roomB = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'RoomTwo', type: 'private' });

    const roomAId = roomA.body.room._id;
    const roomBId = roomB.body.room._id;

    const presignA = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ roomId: roomAId, filename: 'doc.pdf', contentType: 'application/pdf', size: 2048 });
    expect(presignA.status).toBe(200);

    // Attaching RoomA's file key to a message in RoomB must fail
    const crossRoomAck = await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        {
          roomId: roomBId,
          text: '',
          attachments: [
            {
              key: presignA.body.key,
              name: 'doc.pdf',
              contentType: 'application/pdf',
              size: 2048,
            },
          ],
        },
        resolve
      );
    });
    expect(crossRoomAck.ok).toBe(false);
    expect(crossRoomAck.error).toMatch(/prefix|invalid attachment/i);

    // Attachment-only message (empty text) in RoomA succeeds and returns presigned GET URL
    const incomingPromise = new Promise((resolve) => alice.socket.once('message:new', resolve));
    const okAck = await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        {
          roomId: roomAId,
          text: '',
          attachments: [
            {
              key: presignA.body.key,
              name: 'doc.pdf',
              contentType: 'application/pdf',
              size: 2048,
            },
          ],
        },
        resolve
      );
    });
    expect(okAck.ok).toBe(true);

    const broadcasted = await incomingPromise;
    expect(broadcasted.text).toBe('');
    expect(broadcasted.attachments).toHaveLength(1);
    expect(broadcasted.attachments[0].scanStatus).toBe('pending');
    expect(broadcasted.attachments[0].url).toBeNull();

    // Mark attachment clean (simulating scan worker) and verify history returns presigned GET URL
    await Message.updateOne(
      { _id: broadcasted._id, 'attachments.key': presignA.body.key },
      { $set: { 'attachments.$.scanStatus': 'clean' } },
      { bypassTenantScope: true }
    );

    const historyRes = await request(app)
      .get(`/api/rooms/${roomAId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.messages[0].attachments[0].url).toContain(presignA.body.key);
  });
});
