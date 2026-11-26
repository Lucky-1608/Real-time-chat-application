import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import { MAX_ROOMS_PER_USER } from '../src/services/roomService.js';

describe('Sub-phase 6.3: Rooms & Users REST API', () => {
  let mongoServer;

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

  async function register(app, username) {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password: 'password123' });
    return res.body;
  }

  it('lists my rooms with lastMessage preview, unreadCount (excluding own), and DM otherUser', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice');
    const bob = await register(app, 'Bob');

    // Create DM between Alice and Bob
    const dmRes = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: bob.user.id });
    expect(dmRes.status).toBe(201);
    const dmId = dmRes.body.room._id;

    // Bob sends 2 messages and Alice sends 1 message in DM
    await new Promise((r) => setTimeout(r, 15));
    await Message.create({
      room: dmId,
      sender: bob.user.id,
      senderName: 'Bob',
      text: 'Hey Alice 1',
    });
    await Message.create({
      room: dmId,
      sender: bob.user.id,
      senderName: 'Bob',
      text: 'Hey Alice 2',
    });
    await Message.create({
      room: dmId,
      sender: alice.user.id,
      senderName: 'Alice',
      text: 'Own message should not count as unread',
    });

    const listRes = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`);

    expect(listRes.status).toBe(200);
    const dmRoom = listRes.body.rooms.find((r) => r._id === dmId);
    expect(dmRoom).toBeDefined();
    expect(dmRoom.type).toBe('dm');
    expect(dmRoom.otherUser).toMatchObject({ id: bob.user.id, username: 'Bob' });
    expect(dmRoom.lastMessage.text).toBe('Own message should not count as unread');
    expect(dmRoom.unreadCount).toBe(2);
  });

  it('creates public/private rooms, rejects duplicate public names case-insensitively, and supports discovery + join', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice');
    const bob = await register(app, 'Bob');

    const createPub = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Frontend', type: 'public' });
    expect(createPub.status).toBe(201);

    const dupPub = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'frontend', type: 'public' });
    expect(dupPub.status).toBe(409);

    // Bob discovers "Frontend" via GET /api/rooms/public?q=front
    const discover = await request(app)
      .get('/api/rooms/public?q=front')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(discover.status).toBe(200);
    expect(discover.body.rooms.map((r) => r.name)).toEqual(['Frontend']);

    // Bob joins Frontend; it disappears from /api/rooms/public
    const joinRes = await request(app)
      .post(`/api/rooms/${createPub.body.room._id}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(joinRes.status).toBe(200);

    const discoverAfter = await request(app)
      .get('/api/rooms/public?q=front')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(discoverAfter.body.rooms).toHaveLength(0);
  });

  it('handles DM idempotency, self-DM rejection, and concurrent creation', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice');
    const bob = await register(app, 'Bob');

    const selfDm = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: alice.user.id });
    expect(selfDm.status).toBe(400);

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/rooms/dm')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ userId: bob.user.id }),
      request(app)
        .post('/api/rooms/dm')
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ userId: alice.user.id }),
    ]);

    expect([200, 201]).toContain(res1.status);
    expect([200, 201]).toContain(res2.status);
    expect(res1.body.room._id).toBe(res2.body.room._id);
    expect(await Room.countDocuments({ type: 'dm' })).toBe(1);
  });

  it('enforces owner-only invites on private rooms and leave rules (member leaves, owner & DM blocked)', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice');
    const bob = await register(app, 'Bob');
    const charlie = await register(app, 'Charlie');

    const priv = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'SecretTeam', type: 'private', memberIds: [bob.user.id] });
    expect(priv.status).toBe(201);
    const privId = priv.body.room._id;

    // Non-owner Bob cannot invite Charlie
    const bobInvite = await request(app)
      .post(`/api/rooms/${privId}/members`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ memberIds: [charlie.user.id] });
    expect(bobInvite.status).toBe(403);

    // Owner Alice invites Charlie
    const aliceInvite = await request(app)
      .post(`/api/rooms/${privId}/members`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [charlie.user.id] });
    expect(aliceInvite.status).toBe(200);
    expect(aliceInvite.body.addedMemberIds).toEqual([charlie.user.id]);

    // Owner Alice cannot leave without deleting/transferring
    const ownerLeave = await request(app)
      .delete(`/api/rooms/${privId}/members/me`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(ownerLeave.status).toBe(400);

    // Member Bob can leave
    const bobLeave = await request(app)
      .delete(`/api/rooms/${privId}/members/me`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobLeave.status).toBe(200);

    // DM cannot be left
    const dm = await request(app)
      .post('/api/rooms/dm')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: bob.user.id });
    const dmLeave = await request(app)
      .delete(`/api/rooms/${dm.body.room._id}/members/me`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(dmLeave.status).toBe(400);
  });

  it('paginates /api/rooms/:id/messages oldest-first and enforces membership', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice');
    const bob = await register(app, 'Bob');

    const priv = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'PrivateLogs', type: 'private' });
    const roomId = priv.body.room._id;

    const base = new Date('2026-01-01T10:00:00.000Z').getTime();
    for (let i = 1; i <= 4; i++) {
      await Message.create({
        room: roomId,
        sender: alice.user.id,
        senderName: 'Alice',
        text: `p-${i}`,
        createdAt: new Date(base + i * 1000),
        updatedAt: new Date(base + i * 1000),
      });
    }

    const outsider = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(outsider.status).toBe(404);

    const page1 = await request(app)
      .get(`/api/rooms/${roomId}/messages?limit=2`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.messages.map((m) => m.text)).toEqual(['p-3', 'p-4']);
  });

  it('searches users by prefix via GET /api/users?q= excluding self, capped at 20, without passwordHash', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice');
    for (let i = 1; i <= 22; i++) {
      await User.create({
        username: `DevUser_${i}`,
        usernameLower: `devuser_${i}`,
        passwordHash: 'secret-hash',
      });
    }

    const res = await request(app)
      .get('/api/users?q=dev')
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(20);
    expect(res.body.users.every((u) => u.id !== alice.user.id)).toBe(true);
    expect(res.body.users.every((u) => u.passwordHash === undefined)).toBe(true);
  });

  it('enforces MAX_ROOMS_PER_USER cap on room creation', async () => {
    const app = createApp();
    const alice = await register(app, 'Alice'); // already in General (1)

    const bulk = [];
    for (let i = 1; i < MAX_ROOMS_PER_USER; i++) {
      bulk.push({
        name: `Room_${i}`,
        nameLower: `room_${i}`,
        type: 'private',
        createdBy: alice.user.id,
        members: [{ user: alice.user.id, role: 'owner' }],
      });
    }
    await Room.insertMany(bulk);

    const overCap = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'OneTooMany', type: 'private' });
    expect(overCap.status).toBe(400);
    expect(overCap.body.error).toMatch(/Room limit reached/i);
  });
});
