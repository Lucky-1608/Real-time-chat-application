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

describe('Phase 4: Presence, Typing Indicators, Read Receipts & Reconnect Catch-Up', () => {
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
    await Promise.all([User.deleteMany({}), Message.deleteMany({})]);
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
    attachSockets(httpServer);
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

  it('tracks multi-tab presence and only marks user offline when last tab disconnects', async () => {
    const { app, url } = await startServer();
    const aliceTab1 = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    // Open second tab for Alice
    const aliceTab2 = createClient(url, {
      transports: ['websocket'],
      auth: { token: aliceTab1.token },
    });
    socketsToClose.push(aliceTab2);
    await new Promise((resolve) => aliceTab2.once('connect', resolve));

    let latestList = [];
    bob.socket.on('presence:list', (list) => {
      latestList = list;
    });

    // Close Alice tab 1: Alice must remain online because tab 2 is still connected
    aliceTab1.socket.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Close Alice tab 2: Alice should now be removed from online list
    const wentOffline = new Promise((resolve) => {
      bob.socket.once('presence:list', resolve);
    });
    aliceTab2.disconnect();
    latestList = await wentOffline;

    expect(latestList.map((u) => u.username)).toEqual(['Bob']);
  });

  it('relays typing:start / typing:stop and emits typing:stop on disconnect', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    const typingStarted = new Promise((resolve) => {
      bob.socket.once('typing:start', resolve);
    });
    alice.socket.emit('typing:start');
    const startPayload = await typingStarted;
    expect(startPayload).toEqual({ userId: alice.user.id, username: 'Alice' });

    const typingStoppedOnDisconnect = new Promise((resolve) => {
      bob.socket.once('typing:stop', resolve);
    });
    alice.socket.disconnect();
    const stopPayload = await typingStoppedOnDisconnect;
    expect(stopPayload).toEqual({ userId: alice.user.id, username: 'Alice' });
  });

  it('persists read receipts with $addToSet without duplicates and broadcasts { messageIds, userId, username }', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    const msgAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { text: 'Did you see this?' }, resolve);
    });
    expect(msgAck.ok).toBe(true);

    const readEvent = new Promise((resolve) => {
      alice.socket.once('message:read', resolve);
    });

    const readAck = await new Promise((resolve) => {
      bob.socket.emit('message:read', { messageIds: [msgAck.id] }, resolve);
    });
    expect(readAck.ok).toBe(true);

    const broadcast = await readEvent;
    expect(broadcast).toEqual({
      messageIds: [msgAck.id],
      userId: bob.user.id,
      username: 'Bob',
    });

    // Emit duplicate read receipt; $addToSet must keep readBy deduplicated
    await new Promise((resolve) => {
      bob.socket.emit('message:read', { messageIds: [msgAck.id] }, resolve);
    });

    const doc = await Message.findById(msgAck.id).lean();
    expect(doc.readBy.map((id) => id.toString())).toEqual([bob.user.id]);
  });

  it('returns only newer messages when querying with ?after= for reconnect catch-up', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');

    const ack1 = await new Promise((resolve) => {
      alice.socket.emit('message:send', { text: 'before-drop' }, resolve);
    });
    const firstMsg = await Message.findById(ack1.id).lean();

    await new Promise((r) => setTimeout(r, 20));
    await new Promise((resolve) => {
      alice.socket.emit('message:send', { text: 'while-offline' }, resolve);
    });

    const catchUp = await request(app)
      .get(`/api/messages?after=${encodeURIComponent(firstMsg.createdAt.toISOString())}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(catchUp.status).toBe(200);
    expect(catchUp.body.messages.map((m) => m.text)).toEqual(['while-offline']);
  });
});
