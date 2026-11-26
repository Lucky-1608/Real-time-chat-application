import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { EDIT_WINDOW_MS } from '../src/sockets/chatHandlers.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';

describe('Sub-phase 7.1: Edit & Soft-Delete Messages', () => {
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

  it('allows author to edit within 15m, rejects non-author and expired window, and syncs via /changes', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');
    const charlie = await registerAndConnect(app, url, 'Charlie');

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'EditRoom', type: 'private', memberIds: [bob.user.id] });
    const roomId = roomRes.body.room._id;

    let charlieSawUpdate = false;
    charlie.socket.on('message:updated', () => {
      charlieSawUpdate = true;
    });

    const sendAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: 'Original text' }, resolve);
    });

    // Non-author Bob cannot edit Alice's message
    const bobEdit = await new Promise((resolve) => {
      bob.socket.emit(
        'message:edit',
        { roomId, messageId: sendAck.id, text: 'Hijacked' },
        resolve
      );
    });
    expect(bobEdit.ok).toBe(false);

    // Author Alice edits within window
    const bobUpdated = new Promise((resolve) => bob.socket.once('message:updated', resolve));
    const aliceEdit = await new Promise((resolve) => {
      alice.socket.emit(
        'message:edit',
        { roomId, messageId: sendAck.id, text: 'Edited text' },
        resolve
      );
    });
    expect(aliceEdit.ok).toBe(true);

    const updatedPayload = await bobUpdated;
    expect(updatedPayload.text).toBe('Edited text');
    expect(updatedPayload.editedAt).toBeTruthy();

    // Sync endpoint returns the edited message
    const changesRes = await request(app)
      .get(
        `/api/rooms/${roomId}/changes?since=${encodeURIComponent(
          new Date(Date.now() - 60_000).toISOString()
        )}`
      )
      .set('Authorization', `Bearer ${bob.token}`);
    expect(changesRes.status).toBe(200);
    expect(changesRes.body.changes[0].text).toBe('Edited text');

    // Expired edit window (> 15 minutes) is rejected (use collection driver since createdAt is immutable in Mongoose)
    await Message.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(sendAck.id) },
      { $set: { createdAt: new Date(Date.now() - EDIT_WINDOW_MS - 10_000) } }
    );
    const expiredEdit = await new Promise((resolve) => {
      alice.socket.emit(
        'message:edit',
        { roomId, messageId: sendAck.id, text: 'Too late' },
        resolve
      );
    });
    expect(expiredEdit.ok).toBe(false);
    expect(expiredEdit.error).toMatch(/expired/i);

    await new Promise((r) => setTimeout(r, 60));
    expect(charlieSawUpdate).toBe(false);
  });

  it('supports soft-delete by author and room owner moderation, prevents cross-room IDOR, and never leaks deleted text', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'Alice');
    const bob = await registerAndConnect(app, url, 'Bob');
    const charlie = await registerAndConnect(app, url, 'Charlie');

    const roomA = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'RoomA', type: 'private', memberIds: [bob.user.id] });
    const roomB = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'RoomB', type: 'private', memberIds: [bob.user.id] });

    const roomAId = roomA.body.room._id;
    const roomBId = roomB.body.room._id;

    // Bob posts a message in RoomA
    const bobAck = await new Promise((resolve) => {
      bob.socket.emit('message:send', { roomId: roomAId, text: 'Secret Bob text' }, resolve);
    });

    // Cross-room ID mismatch: Bob tries to edit/delete RoomA's message using RoomB's ID
    const crossEdit = await new Promise((resolve) => {
      bob.socket.emit(
        'message:edit',
        { roomId: roomBId, messageId: bobAck.id, text: 'Cross room' },
        resolve
      );
    });
    expect(crossEdit.ok).toBe(false);

    const crossDel = await new Promise((resolve) => {
      bob.socket.emit('message:delete', { roomId: roomBId, messageId: bobAck.id }, resolve);
    });
    expect(crossDel.ok).toBe(false);

    // Room owner Alice moderates (deletes) Bob's message in RoomA
    let charlieSawDelete = false;
    charlie.socket.on('message:deleted', () => {
      charlieSawDelete = true;
    });

    const bobDeletedEvent = new Promise((resolve) =>
      bob.socket.once('message:deleted', resolve)
    );
    const ownerDel = await new Promise((resolve) => {
      alice.socket.emit('message:delete', { roomId: roomAId, messageId: bobAck.id }, resolve);
    });
    expect(ownerDel.ok).toBe(true);

    const deletedPayload = await bobDeletedEvent;
    expect(deletedPayload).toMatchObject({ roomId: roomAId, messageId: bobAck.id });
    expect(deletedPayload.text).toBeUndefined();

    // Deleted message cannot be edited
    const editDeleted = await new Promise((resolve) => {
      bob.socket.emit(
        'message:edit',
        { roomId: roomAId, messageId: bobAck.id, text: 'Resurrect' },
        resolve
      );
    });
    expect(editDeleted.ok).toBe(false);

    // REST history & room preview never leak deleted text
    const history = await request(app)
      .get(`/api/rooms/${roomAId}/messages`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(history.body.messages[0].text).toBe('');
    expect(history.body.messages[0].deletedAt).toBeTruthy();

    const roomsList = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${bob.token}`);
    const roomAEntry = roomsList.body.rooms.find((r) => r._id === roomAId);
    expect(roomAEntry.lastMessage.text).toBe('');
    expect(roomAEntry.lastMessage.deletedAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 60));
    expect(charlieSawDelete).toBe(false);
  });
});
