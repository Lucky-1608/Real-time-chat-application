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

describe('Sub-phase 6.4: Room-Scoped Sockets, Live Join/Leave & DM Events', () => {
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

  it('isolates message:new, typing, and message:read to room members (client C outside receives nothing)', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');
    const charlie = await registerAndConnect(app, url, 'Charlie');

    // Alice creates a private room with Bob; Charlie is NOT a member
    const createRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'ABOnly', type: 'private', memberIds: [bob.user.id] });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.room._id;

    let charlieSawMessage = false;
    let charlieSawTyping = false;
    let charlieSawRead = false;
    charlie.socket.on('message:new', (msg) => {
      if (msg.room === roomId) charlieSawMessage = true;
    });
    charlie.socket.on('typing:start', (ev) => {
      if (ev.roomId === roomId) charlieSawTyping = true;
    });
    charlie.socket.on('message:read', (ev) => {
      if (ev.roomId === roomId) charlieSawRead = true;
    });

    // Alice types and sends a message; Bob receives both
    const bobTyping = new Promise((resolve) => bob.socket.once('typing:start', resolve));
    alice.socket.emit('typing:start', { roomId });
    expect(await bobTyping).toMatchObject({ roomId, userId: alice.user.id });

    const bobMsg = new Promise((resolve) => bob.socket.once('message:new', resolve));
    const sendAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'Private hello' }, resolve);
    });
    expect(sendAck.ok).toBe(true);
    const received = await bobMsg;
    expect(received.room).toBe(roomId);
    expect(received.text).toBe('Private hello');

    // Bob marks message read; Alice receives read receipt
    const aliceRead = new Promise((resolve) => alice.socket.once('message:read', resolve));
    bob.socket.emit('message:read', { roomId, messageIds: [sendAck.id] });
    expect(await aliceRead).toMatchObject({ roomId, userId: bob.user.id, messageIds: [sendAck.id] });

    await new Promise((r) => setTimeout(r, 80));
    expect(charlieSawMessage).toBe(false);
    expect(charlieSawTyping).toBe(false);
    expect(charlieSawRead).toBe(false);
  });

  it('supports live-join when A invites B to a private room without reconnecting', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    // Alice creates private room without Bob first
    const createRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'LiveInvite', type: 'private' });
    const roomId = createRes.body.room._id;

    // Bob listens for room:created on his personal channel
    const bobInvited = new Promise((resolve) => bob.socket.once('room:created', resolve));
    const inviteRes = await request(app)
      .post(`/api/rooms/${roomId}/members`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] });
    expect(inviteRes.status).toBe(200);

    const invitePayload = await bobInvited;
    expect(invitePayload.room._id).toBe(roomId);

    // Alice sends a message immediately; Bob receives it without reconnecting
    const bobMsg = new Promise((resolve) => bob.socket.once('message:new', resolve));
    await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'Welcome live!' }, resolve);
    });
    const received = await bobMsg;
    expect(received.text).toBe('Welcome live!');
  });

  it('emits room:created to both users on DM creation and stops delivery after leaving a room', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');

    const aliceDmCreated = new Promise((resolve) => alice.socket.once('room:created', resolve));
    const bobDmCreated = new Promise((resolve) => bob.socket.once('room:created', resolve));

    const dmRes = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: bob.user.id });
    expect(dmRes.status).toBe(201);

    const [aEv, bEv] = await Promise.all([aliceDmCreated, bobDmCreated]);
    expect(aEv.room.otherUser.username).toBe('Bob');
    expect(bEv.room.otherUser.username).toBe('Alice');

    // Public room leave test: Bob joins then leaves, and stops receiving messages immediately
    const pubRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'TempRoom', type: 'public' });
    const pubId = pubRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${pubId}/join`)
      .set('Authorization', `Bearer ${bob.token}`);

    let bobGotAfterLeave = false;
    bob.socket.on('message:new', (msg) => {
      if (msg.room === pubId) bobGotAfterLeave = true;
    });

    const bobLeft = new Promise((resolve) => bob.socket.once('room:left', resolve));
    await request(app)
      .delete(`/api/rooms/${pubId}/members/me`)
      .set('Authorization', `Bearer ${bob.token}`);
    await bobLeft;

    await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId: pubId, text: 'After leave' }, resolve);
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(bobGotAfterLeave).toBe(false);
  });
});
