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

describe('Sub-phase 7.2: Atomic Emoji Reactions', () => {
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

  it('toggles reactions on/off, rejects disallowed emojis & non-members, and persists across reload', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');
    const charlie = await registerAndConnect(app, url, 'Charlie');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'ReactRoom', type: 'private', memberIds: [bob.user.id] });
    const roomId = roomRes.body.room._id;

    const msgAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'React to me' }, resolve);
    });

    // Disallowed emoji rejected
    const badEmoji = await new Promise((resolve) => {
      alice.socket.emit(
        'reaction:toggle',
        { roomId, messageId: msgAck.id, emoji: '💩' },
        resolve
      );
    });
    expect(badEmoji.ok).toBe(false);

    // Non-member rejected
    const outsiderAck = await new Promise((resolve) => {
      charlie.socket.emit(
        'reaction:toggle',
        { roomId, messageId: msgAck.id, emoji: '👍' },
        resolve
      );
    });
    expect(outsiderAck.ok).toBe(false);

    // Toggle on
    const bobUpdated = new Promise((resolve) => bob.socket.once('reaction:updated', resolve));
    const onAck = await new Promise((resolve) => {
      alice.socket.emit(
        'reaction:toggle',
        { roomId, messageId: msgAck.id, emoji: '👍' },
        resolve
      );
    });
    expect(onAck.ok).toBe(true);
    expect(await bobUpdated).toMatchObject({
      roomId,
      messageId: msgAck.id,
      reactions: [{ emoji: '👍', users: [alice.user.id] }],
    });

    // Persisted in REST history
    const history1 = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(history1.body.messages[0].reactions).toEqual([
      { emoji: '👍', users: [alice.user.id] },
    ]);

    // Toggle off
    const offAck = await new Promise((resolve) => {
      alice.socket.emit(
        'reaction:toggle',
        { roomId, messageId: msgAck.id, emoji: '👍' },
        resolve
      );
    });
    expect(offAck.ok).toBe(true);
    expect(offAck.reactions).toEqual([]);
  });

  it('preserves both reactions when two users react simultaneously with the same emoji', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'RaceRoom', type: 'private', memberIds: [bob.user.id] });
    const roomId = roomRes.body.room._id;

    const msgAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'Simultaneous!' }, resolve);
    });

    const [ackA, ackB] = await Promise.all([
      new Promise((resolve) => {
        alice.socket.emit(
          'reaction:toggle',
          { roomId, messageId: msgAck.id, emoji: '❤️' },
          resolve
        );
      }),
      new Promise((resolve) => {
        bob.socket.emit(
          'reaction:toggle',
          { roomId, messageId: msgAck.id, emoji: '❤️' },
          resolve
        );
      }),
    ]);

    expect(ackA.ok).toBe(true);
    expect(ackB.ok).toBe(true);

    const history = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`);
    const heart = history.body.messages[0].reactions.find((r) => r.emoji === '❤️');
    expect(heart).toBeDefined();
    expect(heart.users.sort()).toEqual([alice.user.id, bob.user.id].sort());
  });
});
