import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import User from '../src/models/User.js';
import Room, { makeDmKey } from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import { assertRoomOwner, getRoomIfMember } from '../src/services/roomAccess.js';
import { ensureDefaultWorkspace } from '../src/services/workspaceMigration.js';

describe('Sub-phase 6.2: Room Authorization & IDOR Protection', () => {
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

  async function setupUsersAndServer() {
    const app = createApp();
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    const url = `http://127.0.0.1:${port}`;

    const regA = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'password123' });
    const regB = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Bob', password: 'password123' });
    const regC = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Charlie', password: 'password123' });

    return { app, url, alice: regA.body, bob: regB.body, charlie: regC.body };
  }

  describe('getRoomIfMember & assertRoomOwner', () => {
    it('rejects invalid ObjectIds with 400 and non-existent rooms with 404', async () => {
      const fakeUserId = new mongoose.Types.ObjectId();
      await expect(getRoomIfMember('not-an-object-id', fakeUserId)).rejects.toMatchObject({
        statusCode: 400,
      });

      const missingId = new mongoose.Types.ObjectId().toString();
      await expect(getRoomIfMember(missingId, fakeUserId)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('returns 403 for non-members of public rooms and 404 for private/DM rooms (no existence leak)', async () => {
      const wsId = new mongoose.Types.ObjectId();
      const ownerId = new mongoose.Types.ObjectId();
      const outsiderId = new mongoose.Types.ObjectId();
      const partnerId = new mongoose.Types.ObjectId();

      const pub = await Room.create({
        workspace: wsId,
        name: 'Engineering',
        type: 'public',
        createdBy: ownerId,
        members: [{ user: ownerId, role: 'owner' }],
      });
      const priv = await Room.create({
        workspace: wsId,
        name: 'Secret',
        type: 'private',
        createdBy: ownerId,
        members: [{ user: ownerId, role: 'owner' }],
      });
      const dm = await Room.create({
        workspace: wsId,
        type: 'dm',
        dmKey: makeDmKey(ownerId, partnerId),
        createdBy: ownerId,
        members: [
          { user: ownerId, role: 'member' },
          { user: partnerId, role: 'member' },
        ],
      });

      await expect(getRoomIfMember(pub._id.toString(), outsiderId)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(getRoomIfMember(priv._id.toString(), outsiderId)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(getRoomIfMember(dm._id.toString(), outsiderId)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('enforces owner role for owner-only actions', async () => {
      const wsId = new mongoose.Types.ObjectId();
      const ownerId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const priv = await Room.create({
        workspace: wsId,
        name: 'PrivateOps',
        type: 'private',
        createdBy: ownerId,
        members: [
          { user: ownerId, role: 'owner' },
          { user: memberId, role: 'member' },
        ],
      });

      await expect(assertRoomOwner(priv._id.toString(), memberId)).rejects.toMatchObject({
        statusCode: 403,
      });

      const res = await assertRoomOwner(priv._id.toString(), ownerId);
      expect(res.member.role).toBe('owner');
    });
  });

  describe('IDOR checks across REST and Socket handlers', () => {
    it('prevents user B from reading, posting to, typing in, or marking read in user A private room or DM', async () => {
      const { app, url, alice, bob, charlie } = await setupUsersAndServer();
      const { workspace } = await ensureDefaultWorkspace();

      const alicePrivate = await Room.create({
        workspace: workspace._id,
        name: 'AliceOnly',
        type: 'private',
        createdBy: alice.user.id,
        members: [{ user: alice.user.id, role: 'owner' }],
      });
      const aliceCharlieDm = await Room.create({
        workspace: workspace._id,
        type: 'dm',
        dmKey: makeDmKey(alice.user.id, charlie.user.id),
        createdBy: alice.user.id,
        members: [
          { user: alice.user.id, role: 'member' },
          { user: charlie.user.id, role: 'member' },
        ],
      });

      const privateMsg = await Message.create({
        workspace: workspace._id,
        room: alicePrivate._id,
        sender: alice.user.id,
        senderName: alice.user.username,
        text: 'Top secret',
      });

      // REST IDOR: Bob tries to read Alice's private room and Alice-Charlie DM
      const readPriv = await request(app)
        .get(`/api/messages?roomId=${alicePrivate._id}`)
        .set('Authorization', `Bearer ${bob.token}`);
      expect(readPriv.status).toBe(404);

      const readDm = await request(app)
        .get(`/api/messages?roomId=${aliceCharlieDm._id}`)
        .set('Authorization', `Bearer ${bob.token}`);
      expect(readDm.status).toBe(404);

      // Socket IDOR: Bob connects and tries to post, type, and mark read in Alice's private room & DM
      const bobSocket = createClient(url, {
        transports: ['websocket'],
        auth: { token: bob.token },
      });
      socketsToClose.push(bobSocket);
      await new Promise((resolve, reject) => {
        bobSocket.once('connect', resolve);
        bobSocket.once('connect_error', reject);
      });

      const sendPrivAck = await new Promise((resolve) => {
        bobSocket.emit(
          'message:send',
          { roomId: alicePrivate._id.toString(), text: 'Hacked' },
          resolve
        );
      });
      expect(sendPrivAck.ok).toBe(false);

      const sendDmAck = await new Promise((resolve) => {
        bobSocket.emit(
          'message:send',
          { roomId: aliceCharlieDm._id.toString(), text: 'Hacked DM' },
          resolve
        );
      });
      expect(sendDmAck.ok).toBe(false);

      const typePrivAck = await new Promise((resolve) => {
        bobSocket.emit('typing:start', { roomId: alicePrivate._id.toString() }, resolve);
      });
      expect(typePrivAck.ok).toBe(false);

      const readPrivAck = await new Promise((resolve) => {
        bobSocket.emit(
          'message:read',
          { roomId: alicePrivate._id.toString(), messageIds: [privateMsg._id.toString()] },
          resolve
        );
      });
      expect(readPrivAck.ok).toBe(false);

      // Confirm no unauthorized messages were persisted in Alice's private room
      expect(await Message.countDocuments({ workspace: workspace._id, room: alicePrivate._id })).toBe(1);
      expect(await Message.countDocuments({ workspace: workspace._id, room: aliceCharlieDm._id })).toBe(0);
    });
  });
});
