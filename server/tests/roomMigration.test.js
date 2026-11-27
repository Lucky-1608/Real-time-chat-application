import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Room, { makeDmKey } from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import { migrateRooms } from '../src/services/roomMigration.js';

describe('Sub-phase 6.1: Room Schema, DM Uniqueness & Idempotent Migration', () => {
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

  it('enforces unique dmKey even under simultaneous DM creation attempts', async () => {
    const alice = await User.create({
      username: 'Alice',
      usernameLower: 'alice',
      passwordHash: 'hash',
    });
    const bob = await User.create({
      username: 'Bob',
      usernameLower: 'bob',
      passwordHash: 'hash',
    });

    const dmKey = makeDmKey(alice._id, bob._id);
    expect(dmKey).toBe(makeDmKey(bob._id, alice._id));

    const wsId = new mongoose.Types.ObjectId();
    const results = await Promise.allSettled([
      Room.create({
        workspace: wsId,
        type: 'dm',
        dmKey,
        createdBy: alice._id,
        members: [
          { user: alice._id, role: 'member' },
          { user: bob._id, role: 'member' },
        ],
      }),
      Room.create({
        workspace: wsId,
        type: 'dm',
        dmKey,
        createdBy: bob._id,
        members: [
          { user: bob._id, role: 'member' },
          { user: alice._id, role: 'member' },
        ],
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe(11000);

    const dmCount = await Room.countDocuments({ workspace: wsId, type: 'dm', dmKey });
    expect(dmCount).toBe(1);
  });

  it('enforces case-insensitive unique name for public rooms while allowing DMs without names', async () => {
    const wsId = new mongoose.Types.ObjectId();
    await Room.create({ workspace: wsId, name: 'Design', type: 'public' });
    await expect(Room.create({ workspace: wsId, name: 'design', type: 'public' })).rejects.toMatchObject({
      code: 11000,
    });

    // Multiple DM rooms without names or nameLower must not collide on the sparse/partial indexes.
    const u1 = new mongoose.Types.ObjectId();
    const u2 = new mongoose.Types.ObjectId();
    const u3 = new mongoose.Types.ObjectId();
    await Room.create({ workspace: wsId, type: 'dm', dmKey: makeDmKey(u1, u2), members: [] });
    await Room.create({ workspace: wsId, type: 'dm', dmKey: makeDmKey(u1, u3), members: [] });
    expect(await Room.countDocuments({ workspace: wsId, type: 'dm' })).toBe(2);
  });

  it('runs migrateRooms idempotently: creates General, adds users, migrates legacy messages, and repeats cleanly', async () => {
    const alice = await User.create({
      username: 'Alice',
      usernameLower: 'alice',
      passwordHash: 'hash',
    });
    const bob = await User.create({
      username: 'Bob',
      usernameLower: 'bob',
      passwordHash: 'hash',
    });

    // Insert legacy messages without a `room` field via raw collection driver.
    await Message.collection.insertMany([
      {
        roomId: 'global',
        sender: alice._id,
        senderName: 'Alice',
        text: 'Legacy message 1',
        readBy: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        sender: bob._id,
        senderName: 'Bob',
        text: 'Legacy message 2',
        readBy: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const firstRun = await migrateRooms();
    expect(firstRun.createdGeneral).toBe(true);
    expect(firstRun.addedUsersCount).toBe(2);
    expect(firstRun.migratedMessagesCount).toBe(2);

    const general = await Room.findById(firstRun.generalRoomId, null, { bypassTenantScope: true }).lean();
    expect(general.name).toBe('General');
    expect(general.type).toBe('public');
    expect(general.members.map((m) => m.user.toString()).sort()).toEqual(
      [alice._id.toString(), bob._id.toString()].sort()
    );

    const migratedMsgs = await Message.find({ workspace: general.workspace, room: general._id }).lean();
    expect(migratedMsgs).toHaveLength(2);

    // Second run must change nothing.
    const secondRun = await migrateRooms();
    expect(secondRun.createdGeneral).toBe(false);
    expect(secondRun.addedUsersCount).toBe(0);
    expect(secondRun.migratedMessagesCount).toBe(0);
  });

  it('auto-adds newly registered users to the General public room', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'NewMember', password: 'password123' });

    expect(res.status).toBe(201);
    const general = await Room.findOne(
      { nameLower: 'general', type: 'public' },
      null,
      { bypassTenantScope: true }
    ).lean();
    expect(general).not.toBeNull();
    expect(general.members.some((m) => m.user.toString() === res.body.user.id)).toBe(true);
  });
});
