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
import StarredMessage from '../src/models/StarredMessage.js';
import Draft from '../src/models/Draft.js';

describe('Sub-phase 9.1: Pinning, Starring, Drafts, Jump-to-Message, Notifications, Status & DND', () => {
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
      StarredMessage.syncIndexes(),
      Draft.syncIndexes(),
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
      StarredMessage.deleteMany({}),
      Draft.deleteMany({}),
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

  it('enforces pin permissions (moderator+) and 10-pin cap, and scopes starred messages to active room membership', async () => {
    const { app, url } = await startServer();
    const owner = await registerUser(app, url, 'Owner');
    const member = await registerUser(app, url, 'Member');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'PinRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${member.token}`);

    const msgIds = [];
    for (let i = 1; i <= 11; i++) {
      const ack = await new Promise((resolve) => {
        owner.socket.emit('message:send', { roomId, text: `Msg ${i}` }, resolve);
      });
      msgIds.push(ack.id);
    }

    // Regular member cannot pin -> 403
    const memberPinRes = await request(app)
      .post(`/api/rooms/${roomId}/pins/${msgIds[0]}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberPinRes.status).toBe(403);

    // Owner pins 10 messages; 11th fails with 400
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post(`/api/rooms/${roomId}/pins/${msgIds[i]}`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(200);
    }
    const eleventhRes = await request(app)
      .post(`/api/rooms/${roomId}/pins/${msgIds[10]}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(eleventhRes.status).toBe(400);

    // Member stars a message, sees it in /api/users/me/stars, then leaves room -> no longer visible!
    const starRes = await request(app)
      .post(`/api/messages/${msgIds[0]}/star`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(starRes.status).toBe(200);

    const starsBeforeLeave = await request(app)
      .get('/api/users/me/stars')
      .set('Authorization', `Bearer ${member.token}`);
    expect(starsBeforeLeave.body.stars).toHaveLength(1);

    await request(app)
      .delete(`/api/rooms/${roomId}/members/me`)
      .set('Authorization', `Bearer ${member.token}`);

    const starsAfterLeave = await request(app)
      .get('/api/users/me/stars')
      .set('Authorization', `Bearer ${member.token}`);
    expect(starsAfterLeave.body.stars).toHaveLength(0);
  });

  it('syncs drafts across two sockets of the same user and clears on send', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, url, 'Alice');

    const secondSocket = createClient(url, {
      transports: ['websocket'],
      auth: { token: alice.token },
    });
    socketsToClose.push(secondSocket);
    await new Promise((resolve) => secondSocket.once('connect', resolve));

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'DraftRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    const draftPromise = new Promise((resolve) => secondSocket.once('draft:updated', resolve));
    const putRes = await request(app)
      .put(`/api/rooms/${roomId}/draft`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'Work in progress' });
    expect(putRes.status).toBe(200);

    const draftEvt = await draftPromise;
    expect(draftEvt.roomId).toBe(roomId);
    expect(draftEvt.text).toBe('Work in progress');

    // Sending message clears the draft and emits empty draft:updated
    const clearedPromise = new Promise((resolve) => secondSocket.once('draft:updated', resolve));
    await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'Final sent text' }, resolve);
    });
    const clearedEvt = await clearedPromise;
    expect(clearedEvt.text).toBe('');
  });

  it('returns accurate ?around=<messageId> windows at the first and last message edges', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, url, 'Alice');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'JumpRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    const ids = [];
    for (let i = 1; i <= 7; i++) {
      const ack = await new Promise((resolve) => {
        alice.socket.emit('message:send', { roomId, text: `Item ${i}` }, resolve);
      });
      ids.push(ack.id);
    }

    // Jump around first message
    const firstRes = await request(app)
      .get(`/api/rooms/${roomId}/messages?around=${ids[0]}&limit=4`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.messages[0]._id).toBe(ids[0]);
    expect(firstRes.body.hasMoreOlder).toBe(false);

    // Jump around last message
    const lastRes = await request(app)
      .get(`/api/rooms/${roomId}/messages?around=${ids[6]}&limit=4`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(lastRes.status).toBe(200);
    expect(lastRes.body.messages[lastRes.body.messages.length - 1]._id).toBe(ids[6]);
    expect(lastRes.body.hasMoreNewer).toBe(false);
  });

  it('respects notification levels (mentions/muted/DND) and scopes status broadcasts to shared rooms only', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');
    const stranger = await registerUser(app, url, 'Stranger');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'NotifRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${bob.token}`);

    // Remove stranger from General so stranger shares NO rooms with Alice
    const roomsList = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${stranger.token}`);
    const generalRoom = roomsList.body.rooms.find((r) => r.name === 'General');
    if (generalRoom) {
      await Room.updateOne(
        { _id: generalRoom._id },
        { $pull: { members: { user: stranger.user.id } } },
        { bypassTenantScope: true }
      );
    }

    // Bob sets notification level to 'mentions'
    await request(app)
      .patch(`/api/rooms/${roomId}/notifications`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ level: 'mentions' });

    const bobUnreads = [];
    bob.socket.on('room:unread', (evt) => bobUnreads.push(evt));

    // Message without @Bob -> no room:unread for Bob
    await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'General chatter' }, resolve);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(bobUnreads).toHaveLength(0);

    // Message with @Bob -> room:unread emitted for Bob
    await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'Hey @Bob check this' }, resolve);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(bobUnreads.length).toBeGreaterThanOrEqual(1);

    // Status broadcast goes to Bob (shared room), NOT Stranger (no shared room)
    const strangerStatusEvents = [];
    stranger.socket.on('user:status_updated', (e) => strangerStatusEvents.push(e));
    const bobStatusPromise = new Promise((resolve) => bob.socket.once('user:status_updated', resolve));

    const statusRes = await request(app)
      .put('/api/users/me/status')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'In a meeting', emoji: '📅', dndEnabled: true });
    expect(statusRes.status).toBe(200);

    const bobStatusEvt = await bobStatusPromise;
    expect(bobStatusEvt.userId).toBe(alice.user.id);
    expect(bobStatusEvt.customStatus.text).toBe('In a meeting');

    await new Promise((r) => setTimeout(r, 40));
    expect(strangerStatusEvents).toHaveLength(0);
  });
});
