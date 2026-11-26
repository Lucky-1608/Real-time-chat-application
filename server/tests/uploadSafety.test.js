import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { createStorageService } from '../src/services/storage.js';
import { createScanWorker, createClamdScanner } from '../src/services/scanWorker.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import AuditEvent from '../src/models/AuditEvent.js';

const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('Sub-phase 8.7: Upload Safety, Quarantine, EXIF Stripping & Malware Scanning', () => {
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
        if (name === 'GetObjectCommand') {
          const obj = objects.get(key);
          if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          return {
            Body: {
              transformToByteArray: async () => new Uint8Array(obj.buffer),
            },
          };
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

    const storageService = createStorageService({
      s3Client: mockS3,
      presigner: mockPresigner,
      bucket: 'test-bucket',
    });

    return { storageService, objects };
  }

  async function startServer({ storageService }) {
    const app = createApp({ storageService });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    const io = attachSockets(httpServer, app, { storageService });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, io, url: `http://127.0.0.1:${port}` };
  }

  async function registerAndConnect(app, url, username) {
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

  it('quarantines pending uploads (not downloadable until clean), strips EXIF GPS from images, and emits attachment:status only to room members', async () => {
    const { storageService, objects } = createInMemoryStorage();
    const { app, io, url } = await startServer({ storageService });

    const alice = await registerAndConnect(app, url, 'Alice');
    const outsider = await registerAndConnect(app, url, 'Outsider');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'PhotoRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    // Create a real JPEG with EXIF GPS/Artist metadata
    const jpegWithExif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 40, b: 200 } },
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: { Artist: 'SecretGPSUser' },
          GPS: { GPSLatitudeRef: 'N' },
        },
      })
      .toBuffer();

    const preMeta = await sharp(jpegWithExif).metadata();
    expect(preMeta.exif).toBeDefined();

    // 1. Presign targets quarantine/<roomId>/...
    const presignRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        roomId,
        filename: 'vacation.jpg',
        contentType: 'image/jpeg',
        size: jpegWithExif.length,
      });
    expect(presignRes.status).toBe(200);
    expect(presignRes.body.key).toMatch(new RegExp(`^quarantine/${roomId}/[0-9a-f-]+\\.jpg$`));

    // Simulate direct-to-S3 PUT into quarantine
    objects.set(presignRes.body.key, {
      buffer: jpegWithExif,
      contentType: 'image/jpeg',
    });

    // 2. Send message with quarantined attachment -> pending and NOT downloadable
    const newMsgPromise = new Promise((resolve) => alice.socket.once('message:new', resolve));
    const ack = await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        {
          roomId,
          text: '',
          attachments: [
            {
              key: presignRes.body.key,
              name: 'vacation.jpg',
              contentType: 'image/jpeg',
              size: jpegWithExif.length,
            },
          ],
        },
        resolve
      );
    });
    expect(ack.ok).toBe(true);

    const pendingMsg = await newMsgPromise;
    expect(pendingMsg.attachments[0].scanStatus).toBe('pending');
    expect(pendingMsg.attachments[0].url).toBeNull();

    // History also refuses to generate presigned GET URL while pending
    const pendingHist = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(pendingHist.body.messages[0].attachments[0].scanStatus).toBe('pending');
    expect(pendingHist.body.messages[0].attachments[0].url).toBeNull();

    // 3. Run scan worker -> strips EXIF, moves to uploads/<roomId>/, deletes quarantine, emits attachment:status
    const outsiderEvents = [];
    outsider.socket.on('attachment:status', (evt) => outsiderEvents.push(evt));
    const aliceStatusPromise = new Promise((resolve) =>
      alice.socket.once('attachment:status', resolve)
    );

    const cleanScanner = {
      scanBuffer: vi.fn(async () => ({ isInfected: false, viruses: [] })),
    };
    const worker = createScanWorker({ storageService, scanner: cleanScanner, io });
    const processed = await worker.processNext();
    expect(processed).toBe(true);

    const statusEvt = await aliceStatusPromise;
    expect(statusEvt.roomId).toBe(roomId);
    expect(statusEvt.messageId).toBe(pendingMsg._id);
    expect(statusEvt.attachmentKey).toBe(presignRes.body.key);
    expect(statusEvt.status).toBe('clean');
    expect(statusEvt.newKey).toMatch(new RegExp(`^uploads/${roomId}/[0-9a-f-]+\\.jpg$`));
    expect(statusEvt.url).toContain(statusEvt.newKey);

    // Quarantine object deleted; final object has NO EXIF metadata
    expect(objects.has(presignRes.body.key)).toBe(false);
    const finalObj = objects.get(statusEvt.newKey);
    expect(finalObj).toBeDefined();
    const postMeta = await sharp(finalObj.buffer).metadata();
    expect(postMeta.exif).toBeUndefined();

    // Non-member never received attachment:status
    await new Promise((r) => setTimeout(r, 50));
    expect(outsiderEvents).toHaveLength(0);

    // History now returns presigned GET URL
    const cleanHist = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(cleanHist.body.messages[0].attachments[0].scanStatus).toBe('clean');
    expect(cleanHist.body.messages[0].attachments[0].url).toContain(statusEvt.newKey);
  });

  it('rejects infected files (EICAR), deletes quarantine object, and logs an audit event', async () => {
    const { storageService, objects } = createInMemoryStorage();
    const { app, io, url } = await startServer({ storageService });
    const alice = await registerAndConnect(app, url, 'Alice');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'ScanRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    const eicarBuf = Buffer.from(EICAR_TEST_STRING, 'utf8');
    const presignRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        roomId,
        filename: 'eicar.txt',
        contentType: 'text/plain',
        size: eicarBuf.length,
      });

    objects.set(presignRes.body.key, { buffer: eicarBuf, contentType: 'text/plain' });

    await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        {
          roomId,
          text: '',
          attachments: [
            {
              key: presignRes.body.key,
              name: 'eicar.txt',
              contentType: 'text/plain',
              size: eicarBuf.length,
            },
          ],
        },
        resolve
      );
    });

    const statusPromise = new Promise((resolve) =>
      alice.socket.once('attachment:status', resolve)
    );
    const infectedScanner = {
      scanBuffer: vi.fn(async () => ({
        isInfected: true,
        viruses: ['Win.Test.EICAR_HDB-1'],
      })),
    };
    const worker = createScanWorker({ storageService, scanner: infectedScanner, io });
    await worker.processNext();

    const statusEvt = await statusPromise;
    expect(statusEvt.status).toBe('rejected');
    expect(objects.has(presignRes.body.key)).toBe(false);

    const hist = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(hist.body.messages[0].attachments[0].scanStatus).toBe('rejected');
    expect(hist.body.messages[0].attachments[0].url).toBeNull();

    const auditDoc = await AuditEvent.findOne({ action: 'upload.rejected' }).lean();
    expect(auditDoc).toBeTruthy();
    expect(auditDoc.metadata.reason).toBe('malware');
  });

  it('rejects type-spoofed files (SVG/HTML disguised as PNG) by magic-byte inspection', async () => {
    const { storageService, objects } = createInMemoryStorage();
    const { app, io, url } = await startServer({ storageService });
    const alice = await registerAndConnect(app, url, 'Alice');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'SpoofRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    const spoofedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    const presignRes = await request(app)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        roomId,
        filename: 'avatar.png',
        contentType: 'image/png',
        size: spoofedSvg.length,
      });

    objects.set(presignRes.body.key, { buffer: spoofedSvg, contentType: 'image/png' });

    await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        {
          roomId,
          text: '',
          attachments: [
            {
              key: presignRes.body.key,
              name: 'avatar.png',
              contentType: 'image/png',
              size: spoofedSvg.length,
            },
          ],
        },
        resolve
      );
    });

    const statusPromise = new Promise((resolve) =>
      alice.socket.once('attachment:status', resolve)
    );
    const cleanScanner = {
      scanBuffer: vi.fn(async () => ({ isInfected: false, viruses: [] })),
    };
    const worker = createScanWorker({ storageService, scanner: cleanScanner, io });
    await worker.processNext();

    const statusEvt = await statusPromise;
    expect(statusEvt.status).toBe('rejected');
    expect(objects.has(presignRes.body.key)).toBe(false);

    const auditDoc = await AuditEvent.findOne({ action: 'upload.rejected' }).lean();
    expect(auditDoc).toBeTruthy();
    expect(auditDoc.metadata.reason).toBe('type_mismatch');
  });

  it.skipIf(process.env.RUN_CLAMAV_INTEGRATION !== 'true')(
    'detects the EICAR test string against a real clamd container',
    async () => {
      const scanner = await createClamdScanner({
        host: process.env.CLAMD_HOST || '127.0.0.1',
        port: Number(process.env.CLAMD_PORT || 3310),
      });
      const res = await scanner.scanBuffer(Buffer.from(EICAR_TEST_STRING, 'utf8'));
      expect(res.isInfected).toBe(true);
    }
  );
});
