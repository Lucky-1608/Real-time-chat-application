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

describe('Sub-phase 9.3: Polls & @Mentions Validation', () => {
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

  it('handles concurrent poll votes atomically, enforces single/multiple/anonymous/closed rules and announcement mode', async () => {
    const { app, url } = await startServer();
    const owner = await registerUser(app, url, 'Owner');
    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'PollRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app).post(`/api/rooms/${roomId}/join`).set('Authorization', `Bearer ${alice.token}`);
    await request(app).post(`/api/rooms/${roomId}/join`).set('Authorization', `Bearer ${bob.token}`);

    // Create single-choice anonymous poll
    const pollRes = await request(app)
      .post(`/api/rooms/${roomId}/polls`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        question: 'Best language?',
        options: ['TypeScript', 'Rust', 'Go'],
        multiple: false,
        anonymous: true,
      });
    expect(pollRes.status).toBe(201);
    const pollMsgId = pollRes.body.message._id;
    const [optA, optB] = pollRes.body.message.poll.options;

    // Single-choice rejects voting for 2 options
    const multiAttempt = await request(app)
      .post(`/api/messages/${pollMsgId}/vote`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ optionIds: [optA.id, optB.id] });
    expect(multiAttempt.status).toBe(400);

    // Concurrent votes from Alice & Bob on same option -> both preserved atomically!
    const [voteAlice, voteBob] = await Promise.all([
      request(app)
        .post(`/api/messages/${pollMsgId}/vote`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ optionIds: [optA.id] }),
      request(app)
        .post(`/api/messages/${pollMsgId}/vote`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ optionIds: [optA.id] }),
    ]);
    expect(voteAlice.status).toBe(200);
    expect(voteBob.status).toBe(200);

    const hist = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`);
    const poll = hist.body.messages[0].poll;
    expect(poll.options[0].count).toBe(2);
    // Anonymous poll omits voter lists
    expect(poll.options[0].votes).toBeUndefined();

    // Owner closes poll -> subsequent votes rejected
    const closeRes = await request(app)
      .post(`/api/messages/${pollMsgId}/poll/close`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(closeRes.status).toBe(200);

    const closedVote = await request(app)
      .post(`/api/messages/${pollMsgId}/vote`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ optionIds: [optB.id] });
    expect(closedVote.status).toBe(400);

    // Announcement mode blocks regular member from creating poll
    await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ announcementMode: true });

    const memberPoll = await request(app)
      .post(`/api/rooms/${roomId}/polls`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ question: 'Blocked?', options: ['Yes', 'No'] });
    expect(memberPoll.status).toBe(403);
  });

  it('validates @mentions against room membership and rejects mentioning non-members', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');
    const outsider = await registerUser(app, url, 'Outsider');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'MentionRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/members`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] });

    // Mentioning a non-member fails
    const badAck = await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        { roomId, text: 'Hey @Outsider', mentions: [outsider.user.id] },
        resolve
      );
    });
    expect(badAck.ok).toBe(false);

    // Mentioning a room member succeeds and stores structured mentions
    const okAck = await new Promise((resolve) => {
      alice.socket.emit(
        'message:send',
        { roomId, text: 'Hey @Bob', mentions: [bob.user.id] },
        resolve
      );
    });
    expect(okAck.ok).toBe(true);

    const msg = await Message.findById(okAck.id, null, { bypassTenantScope: true }).lean();
    expect(msg.mentions.map((id) => id.toString())).toEqual([bob.user.id]);
  });
});
