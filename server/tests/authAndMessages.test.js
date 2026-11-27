import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import User from '../src/models/User.js';
import Message from '../src/models/Message.js';
import Room from '../src/models/Room.js';

describe('Phase 2: Authentication, Persistence & Socket Auth', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Message.deleteMany({}), Room.deleteMany({})]);
  });

  afterEach(async () => {
    for (const sock of socketsToClose.splice(0)) {
      if (sock.connected) sock.disconnect();
    }
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  async function registerUser(app, username, password = 'password123') {
    const res = await request(app).post('/api/auth/register').send({ username, password });
    return res;
  }

  describe('POST /api/auth/register & POST /api/auth/login', () => {
    it('registers a new user and returns JWT + user', async () => {
      const app = createApp();
      const res = await registerUser(app, 'Alice_01', 'secret12345');

      expect(res.status).toBe(201);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user).toMatchObject({ username: 'Alice_01' });
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('rejects duplicate usernames case-insensitively', async () => {
      const app = createApp();
      await registerUser(app, 'Alice_01');
      const dup = await registerUser(app, 'alice_01');

      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatch(/already taken/i);
    });

    it('rejects invalid usernames and short passwords', async () => {
      const app = createApp();
      const badName = await registerUser(app, 'a!', 'password123');
      expect(badName.status).toBe(400);

      const badPass = await registerUser(app, 'valid_user', '123');
      expect(badPass.status).toBe(400);
    });

    it('logs in with valid credentials and returns identical error for wrong user or wrong password', async () => {
      const app = createApp();
      await registerUser(app, 'Bob_99', 'correctpass');

      const okRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'bob_99', password: 'correctpass' });
      expect(okRes.status).toBe(200);
      expect(typeof okRes.body.token).toBe('string');
      expect(okRes.body.user.username).toBe('Bob_99');

      const wrongUser = await request(app)
        .post('/api/auth/login')
        .send({ username: 'nobody', password: 'correctpass' });
      const wrongPass = await request(app)
        .post('/api/auth/login')
        .send({ username: 'Bob_99', password: 'wrongpassword' });

      expect(wrongUser.status).toBe(401);
      expect(wrongPass.status).toBe(401);
      expect(wrongUser.body).toEqual(wrongPass.body);
    });

    it('rate-limits auth routes after 10 attempts', async () => {
      const app = createApp();
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'nope', password: 'nope' });
      }
      const blocked = await request(app)
        .post('/api/auth/login')
        .send({ username: 'nope', password: 'nope' });
      expect(blocked.status).toBe(429);
    });
  });

  describe('GET /api/messages', () => {
    it('rejects requests without a token or with an invalid token', async () => {
      const app = createApp();
      const noToken = await request(app).get('/api/messages');
      expect(noToken.status).toBe(401);

      const badToken = await request(app)
        .get('/api/messages')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expect(badToken.status).toBe(401);
    });

    it('returns cursor-paginated messages oldest-first', async () => {
      const app = createApp();
      const reg = await registerUser(app, 'Paginator');
      const { token, user } = reg.body;

      const general = await Room.findOne(
        { nameLower: 'general', type: 'public' },
        null,
        { bypassTenantScope: true }
      );
      const baseTime = new Date('2026-01-01T12:00:00.000Z').getTime();
      for (let i = 1; i <= 5; i++) {
        await Message.create({
          workspace: general.workspace,
          room: general._id,
          sender: user.id,
          senderName: user.username,
          text: `msg-${i}`,
          createdAt: new Date(baseTime + i * 1000),
          updatedAt: new Date(baseTime + i * 1000),
        });
      }

      const page1 = await request(app)
        .get('/api/messages?limit=3')
        .set('Authorization', `Bearer ${token}`);

      expect(page1.status).toBe(200);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.messages.map((m) => m.text)).toEqual(['msg-3', 'msg-4', 'msg-5']);

      const oldestCursor = page1.body.messages[0].createdAt;
      const page2 = await request(app)
        .get(`/api/messages?limit=3&before=${encodeURIComponent(oldestCursor)}`)
        .set('Authorization', `Bearer ${token}`);

      expect(page2.status).toBe(200);
      expect(page2.body.hasMore).toBe(false);
      expect(page2.body.messages.map((m) => m.text)).toEqual(['msg-1', 'msg-2']);
    });
  });

  describe('Socket JWT auth, message persistence & rate limiting', () => {
    async function startSocketServer() {
      const app = createApp();
      const httpServer = http.createServer(app);
      serversToClose.push(httpServer);
      attachSockets(httpServer);
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const { port } = httpServer.address();
      return { app, url: `http://127.0.0.1:${port}` };
    }

    it('rejects socket connections without a valid JWT', async () => {
      const { url } = await startSocketServer();

      const noAuth = createClient(url, { transports: ['websocket'] });
      socketsToClose.push(noAuth);
      const noAuthErr = await new Promise((resolve) => {
        noAuth.once('connect_error', resolve);
      });
      expect(noAuthErr.message).toBe('unauthorized');

      const badAuth = createClient(url, {
        transports: ['websocket'],
        auth: { token: 'invalid.jwt.token' },
      });
      socketsToClose.push(badAuth);
      const badAuthErr = await new Promise((resolve) => {
        badAuth.once('connect_error', resolve);
      });
      expect(badAuthErr.message).toBe('unauthorized');
    });

    it('persists message:send before broadcasting message:new and enforces rate limits', async () => {
      const { app, url } = await startSocketServer();
      const regA = await registerUser(app, 'SenderA');
      const regB = await registerUser(app, 'ReceiverB');

      const clientA = createClient(url, {
        transports: ['websocket'],
        auth: { token: regA.body.token },
      });
      const clientB = createClient(url, {
        transports: ['websocket'],
        auth: { token: regB.body.token },
      });
      socketsToClose.push(clientA, clientB);

      await Promise.all([
        new Promise((resolve, reject) => {
          clientA.once('connect', resolve);
          clientA.once('connect_error', reject);
        }),
        new Promise((resolve, reject) => {
          clientB.once('connect', resolve);
          clientB.once('connect_error', reject);
        }),
      ]);

      // Reject empty message
      const emptyAck = await new Promise((resolve) => {
        clientA.emit('message:send', { text: '   ' }, resolve);
      });
      expect(emptyAck.ok).toBe(false);

      // Valid message: persist + broadcast + ack
      const receivedByB = new Promise((resolve) => {
        clientB.once('message:new', resolve);
      });
      const ack = await new Promise((resolve) => {
        clientA.emit('message:send', { text: 'Hello from A!' }, resolve);
      });

      expect(ack.ok).toBe(true);
      expect(typeof ack.id).toBe('string');

      const broadcasted = await receivedByB;
      expect(broadcasted._id).toBe(ack.id);
      expect(broadcasted.senderName).toBe('SenderA');
      expect(broadcasted.text).toBe('Hello from A!');

      // Verify persisted in MongoDB and retrievable via REST
      const historyRes = await request(app)
        .get('/api/messages')
        .set('Authorization', `Bearer ${regB.body.token}`);
      expect(historyRes.status).toBe(200);
      expect(historyRes.body.messages).toHaveLength(1);
      expect(historyRes.body.messages[0]._id).toBe(ack.id);

      // Verify per-socket rate limit (10 messages per 10 seconds; 2 attempts already sent: 1 invalid + 1 valid)
      for (let i = 0; i < 8; i++) {
        const res = await new Promise((resolve) => {
          clientA.emit('message:send', { text: `burst-${i}` }, resolve);
        });
        expect(res.ok).toBe(true);
      }
      const limitedAck = await new Promise((resolve) => {
        clientA.emit('message:send', { text: 'burst-over-limit' }, resolve);
      });
      expect(limitedAck.ok).toBe(false);
      expect(limitedAck.error).toMatch(/rate limit/i);
    });
  });
});
