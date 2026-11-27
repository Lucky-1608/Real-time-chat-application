import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { createStorageService } from '../src/services/storage.js';
import { encryptField, decryptField, rotateEncryptedField } from '../src/services/cryptoService.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import Session from '../src/models/Session.js';
import Report from '../src/models/Report.js';
import AuditEvent from '../src/models/AuditEvent.js';

describe('Sub-phase 8.10: Privacy, Encryption Rotation, Account Deletion, Export & Admin Dashboard', () => {
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
      Session.syncIndexes(),
      Report.syncIndexes(),
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
      Session.deleteMany({}),
      Report.deleteMany({}),
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

  function createInMemoryStorage() {
    const objects = new Map();
    const mockS3 = {
      send: vi.fn(async (command) => {
        const name = command.constructor.name;
        const key = command.input.Key;
        if (name === 'HeadObjectCommand') {
          const obj = objects.get(key);
          if (!obj) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
          return { ContentLength: obj.buffer.length, ContentType: obj.contentType };
        }
        if (name === 'PutObjectCommand') {
          objects.set(key, {
            buffer: Buffer.from(command.input.Body),
            contentType: command.input.ContentType,
          });
          return {};
        }
        if (name === 'DeleteObjectCommand') {
          objects.delete(key);
          return {};
        }
        return {};
      }),
    };
    const mockPresigner = vi.fn(async (_client, command) => {
      const key = command.input.Key;
      const isPut = command.constructor.name === 'PutObjectCommand';
      return `https://mock-s3.local/${isPut ? 'put' : 'get'}/${key}`;
    });
    return {
      storageService: createStorageService({
        s3Client: mockS3,
        presigner: mockPresigner,
        bucket: 'test-bucket',
      }),
      objects,
    };
  }

  async function startServer({ storageService } = {}) {
    const app = createApp({ storageService });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app, { storageService });
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

  it('supports AES-256-GCM field encryption round-trip and key rotation', () => {
    const oldKey = 'old-secret-key-at-least-32-chars-long';
    const newKey = 'new-secret-key-at-least-32-chars-long';
    const keysById = new Map([
      ['k1', oldKey],
      ['k2', newKey],
    ]);

    const encrypted = encryptField('sensitive-report-note', { keyId: 'k1', key: oldKey });
    expect(encrypted.startsWith('k1:')).toBe(true);
    expect(decryptField(encrypted, { keysById })).toBe('sensitive-report-note');

    const rotated = rotateEncryptedField(encrypted, {
      keysById,
      newKeyId: 'k2',
      newKey,
    });
    expect(rotated.startsWith('k2:')).toBe(true);
    expect(decryptField(rotated, { keysById })).toBe('sensitive-report-note');
  });

  it('anonymizes messages, deletes uploads, revokes sessions, and purges PII on DELETE /api/account', async () => {
    const { storageService, objects } = createInMemoryStorage();
    const { app, url } = await startServer({ storageService });

    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'SharedRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${bob.token}`);

    // Upload a file and send a message
    const presign = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ roomId, filename: 'pic.png', contentType: 'image/png', size: 512 });
    objects.set(presign.body.key, { buffer: Buffer.from('fake-png'), contentType: 'image/png' });

    await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        {
          roomId,
          text: 'Hello Bob',
          attachments: [
            { key: presign.body.key, name: 'pic.png', contentType: 'image/png', size: 512 },
          ],
        },
        resolve
      );
    });

    // Wrong password rejected
    const badDel = await request(app)
      .delete('/api/account')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: 'WrongPassword123' });
    expect(badDel.status).toBe(401);

    // Valid deletion
    const delRes = await request(app)
      .delete('/api/account')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ password: 'StrongPassword123' });
    expect(delRes.status).toBe(200);

    // User and sessions removed, upload deleted, message anonymized, room ownership transferred to Bob
    expect(await User.findById(alice.user.id)).toBeNull();
    expect(await Session.countDocuments({ user: alice.user.id })).toBe(0);
    expect(objects.has(presign.body.key)).toBe(false);

    const msg = await Message.findOne({ room: roomId }, null, { bypassTenantScope: true }).lean();
    expect(msg.senderName).toBe('Deleted user');
    expect(msg.attachments).toHaveLength(0);

    const updatedRoom = await Room.findById(roomId, null, { bypassTenantScope: true }).lean();
    expect(updatedRoom.members.some((m) => m.user.toString() === alice.user.id)).toBe(false);
    expect(updatedRoom.members.find((m) => m.user.toString() === bob.user.id)?.role).toBe('owner');
  });

  it('exports only the requesting user data and enforces 1/day rate limit', async () => {
    const { storageService, objects } = createInMemoryStorage();
    const { app, url } = await startServer({ storageService });

    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'BobSecretRoom', type: 'private' });
    const bobRoomId = roomRes.body.room._id;

    await new Promise((resolve) => {
      bob.socket.emit('message:send', { roomId: bobRoomId, text: 'Bob secret message' }, resolve);
    });

    const exportRes = await request(app)
      .post('/api/account/export')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.exportUrl).toContain('exports/');

    // Verify exported archive in storage contains Alice's username and NEVER Bob's secret message
    const exportedEntry = [...objects.entries()].find(([k]) => k.startsWith(`exports/${alice.user.id}/`));
    expect(exportedEntry).toBeDefined();
    const rawZipText = exportedEntry[1].buffer.toString('utf8');
    expect(rawZipText).toContain('Alice');
    expect(rawZipText).not.toContain('Bob secret message');

    // Second export on same day is rate limited (429)
    const secondExport = await request(app)
      .post('/api/account/export')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(secondExport.status).toBe(429);
  });

  it('restricts all /api/admin/* endpoints to global admins (403 for non-admins) and audits admin actions', async () => {
    const { app, url } = await startServer();
    const user = await registerUser(app, url, 'RegularUser');
    const target = await registerUser(app, url, 'TargetUser');
    const admin = await registerUser(app, url, 'SiteAdmin');
    await User.updateOne({ _id: admin.user.id }, { $set: { globalRole: 'admin' } });

    const adminRoutes = [
      ['get', '/api/admin/audit'],
      ['get', '/api/admin/users'],
      ['get', '/api/admin/rooms'],
      ['get', '/api/admin/stats'],
      ['post', `/api/admin/users/${target.user.id}/suspend`],
      ['post', `/api/admin/users/${target.user.id}/unsuspend`],
      ['post', `/api/admin/users/${target.user.id}/force-logout`],
    ];

    for (const [method, endpoint] of adminRoutes) {
      const res = await request(app)[method](endpoint).set('Authorization', `Bearer ${user.token}`);
      expect(res.status).toBe(403);
    }

    const statsRes = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.usersCount).toBeGreaterThanOrEqual(3);

    const suspendRes = await request(app)
      .post(`/api/admin/users/${target.user.id}/suspend`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Policy violation' });
    expect(suspendRes.status).toBe(200);

    const auditDoc = await AuditEvent.findOne({ action: 'admin.user_suspend' }).lean();
    expect(auditDoc).toBeTruthy();
  });
});
