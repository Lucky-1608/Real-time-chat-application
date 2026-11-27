import http from 'node:http';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import { createCoturnProvider } from '../src/services/providers/turnProvider.js';

describe('Phase 13: WebRTC Signaling, Ephemeral TURN Credentials & Room Isolation', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      User.syncIndexes(),
      Room.syncIndexes(),
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
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
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
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

  async function registerAndConnect(app, url, username) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'StrongPassword123!' });
    expect(res.status).toBe(201);
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

  it('issues time-limited HMAC TURN credentials without exposing the shared secret', async () => {
    const secret = 'super-secret-turn-key-123';
    const provider = createCoturnProvider({
      urls: ['turn:turn.example.com:3478'],
      sharedSecret: secret,
      ttlSeconds: 300,
    });
    const result = await provider.getIceServers('user-42');
    const turnEntry = result.iceServers.find((s) => String(s.urls).includes('turn:'));
    expect(turnEntry).toBeTruthy();
    expect(turnEntry.username).toMatch(/^\d+:user-42$/);
    const expectedCred = crypto
      .createHmac('sha1', secret)
      .update(turnEntry.username)
      .digest('base64');
    expect(turnEntry.credential).toBe(expectedCred);
    expect(JSON.stringify(result)).not.toContain(secret);

    const { app } = await startServer();
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'TurnUser', password: 'StrongPassword123!' });

    const iceRes = await request(app)
      .get('/api/v1/calls/ice-servers')
      .set('Authorization', `Bearer ${reg.body.token}`);
    expect(iceRes.status).toBe(200);
    expect(Array.isArray(iceRes.body.iceServers)).toBe(true);
    expect(iceRes.body.ttlSeconds).toBeGreaterThan(0);
  });

  it('isolates WebRTC signaling to room members and blocks cross-room / non-member targets', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'CallAlice');
    const bob = await registerAndConnect(app, url, 'CallBob');
    const eve = await registerAndConnect(app, url, 'CallEve');

    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'CallRoom', type: 'private', memberIds: [bob.user.id] });
    const roomId = roomRes.body.room._id;

    // Eve (non-member) cannot join call
    const eveJoin = await new Promise((resolve) => {
      eve.socket.emit('call:join', { roomId }, resolve);
    });
    expect(eveJoin.ok).toBe(false);

    // Alice and Bob join call
    const aliceJoin = await new Promise((resolve) => {
      alice.socket.emit('call:join', { roomId }, resolve);
    });
    expect(aliceJoin.ok).toBe(true);

    const bobJoin = await new Promise((resolve) => {
      bob.socket.emit('call:join', { roomId }, resolve);
    });
    expect(bobJoin.ok).toBe(true);

    // Alice cannot send call:offer to Eve (non-member)
    const badOffer = await new Promise((resolve) => {
      alice.socket.emit(
        'call:offer',
        { roomId, targetUserId: eve.user.id, sdp: { type: 'offer', sdp: 'v=0...' } },
        resolve
      );
    });
    expect(badOffer.ok).toBe(false);

    // Alice sends call:offer to Bob -> Bob receives it
    const bobOfferPromise = new Promise((resolve) => bob.socket.once('call:offer', resolve));
    const okOffer = await new Promise((resolve) => {
      alice.socket.emit(
        'call:offer',
        { roomId, targetUserId: bob.user.id, sdp: { type: 'offer', sdp: 'v=0...' } },
        resolve
      );
    });
    expect(okOffer.ok).toBe(true);
    const receivedOffer = await bobOfferPromise;
    expect(receivedOffer.fromUserId).toBe(alice.user.id);
    expect(receivedOffer.roomId).toBe(roomId);
  });
});
