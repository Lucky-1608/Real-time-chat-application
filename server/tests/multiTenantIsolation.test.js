import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import { scopedRepo } from '../src/services/tenantScope.js';
import { migrateWorkspaces } from '../src/services/workspaceMigration.js';

describe('Sub-phase 10.1: Multi-Tenant Data Model, Tenant Plugin & Migration', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
      User.syncIndexes(),
      Room.syncIndexes(),
      Message.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
      User.deleteMany({}),
      Room.deleteMany({}, { bypassTenantScope: true }),
      Message.deleteMany({}, { bypassTenantScope: true }),
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
      .post('/api/v1/auth/register')
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

  it('rejects unscoped queries on tenant models and enforces workspace path on tenant schemas', async () => {
    const tenantModels = [Room, Message];
    for (const Model of tenantModels) {
      expect(Model.schema.path('workspace')).toBeDefined();
      await expect(Model.find({})).rejects.toThrow(/tenant isolation/i);
      await expect(Model.findOne({ _id: new mongoose.Types.ObjectId() })).rejects.toThrow(
        /tenant isolation/i
      );
    }

    const wsA = await Workspace.create({
      name: 'Alpha',
      slug: 'alpha',
      ownerId: new mongoose.Types.ObjectId(),
    });
    const wsB = await Workspace.create({
      name: 'Beta',
      slug: 'beta',
      ownerId: new mongoose.Types.ObjectId(),
    });

    const repoA = scopedRepo(Room, wsA._id);
    const repoB = scopedRepo(Room, wsB._id);
    await repoA.create({ name: 'AlphaGeneral', type: 'public', members: [] });
    await repoB.create({ name: 'BetaGeneral', type: 'public', members: [] });

    const roomsA = await repoA.find({});
    expect(roomsA).toHaveLength(1);
    expect(roomsA[0].name).toBe('AlphaGeneral');
  });

  it('runs migrateWorkspaces idempotently without duplicating Default workspace or memberships', async () => {
    const u1 = await User.create({
      username: 'LegacyAdmin',
      usernameLower: 'legacyadmin',
      passwordHash: 'hash',
      globalRole: 'admin',
    });
    const u2 = await User.create({
      username: 'LegacyUser',
      usernameLower: 'legacyuser',
      passwordHash: 'hash',
      globalRole: 'user',
    });

    // Insert legacy room & message directly via collection to simulate pre-10.1 data lacking workspace
    const roomInsert = await Room.collection.insertOne({
      name: 'General',
      nameLower: 'general',
      type: 'public',
      members: [{ user: u1._id, role: 'owner' }, { user: u2._id, role: 'member' }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await Message.collection.insertOne({
      room: roomInsert.insertedId,
      sender: u1._id,
      senderName: 'LegacyAdmin',
      text: 'Legacy message',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const first = await migrateWorkspaces();
    expect(first.createdWorkspace).toBe(true);
    expect(first.addedMembers).toBe(2);
    expect(first.migratedRooms).toBe(1);
    expect(first.migratedMessages).toBe(1);

    const adminMembership = await WorkspaceMember.findOne({
      workspace: first.workspace._id,
      user: u1._id,
    }).lean();
    expect(adminMembership.role).toBe('admin');

    const second = await migrateWorkspaces();
    expect(second.createdWorkspace).toBe(false);
    expect(second.addedMembers).toBe(0);
    expect(second.migratedRooms).toBe(0);
    expect(second.migratedMessages).toBe(0);
  });

  it('blocks cross-tenant IDOR across REST and Socket handlers', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, url, 'Alice');
    const bob = await registerUser(app, url, 'Bob');

    const wsA = await Workspace.create({ name: 'OrgA', slug: 'org-a', ownerId: alice.user.id });
    const wsB = await Workspace.create({ name: 'OrgB', slug: 'org-b', ownerId: bob.user.id });

    await WorkspaceMember.create({ workspace: wsA._id, user: alice.user.id, role: 'owner' });
    await WorkspaceMember.create({ workspace: wsB._id, user: bob.user.id, role: 'owner' });

    // Bob creates a public room in OrgB
    const bobRoomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${bob.token}`)
      .set('X-Workspace-Id', wsB._id.toString())
      .send({ name: 'BetaSecretPublic', type: 'public' });
    expect(bobRoomRes.status).toBe(201);
    const roomBId = bobRoomRes.body.room._id;

    // Alice tries to read RoomB messages while scoped to OrgA -> 404
    const crossRead = await request(app)
      .get(`/api/v1/rooms/${roomBId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsA._id.toString());
    expect(crossRead.status).toBe(404);

    // Alice tries to spoof X-Workspace-Id: OrgB -> 403
    const spoofWs = await request(app)
      .get(`/api/v1/rooms/${roomBId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsB._id.toString());
    expect(spoofWs.status).toBe(403);

    // Alice tries to join RoomB from OrgA -> 404
    const crossJoin = await request(app)
      .post(`/api/v1/rooms/${roomBId}/join`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsA._id.toString());
    expect(crossJoin.status).toBe(404);

    // Public room discovery in OrgA never leaks OrgB rooms
    const pubA = await request(app)
      .get('/api/v1/rooms/public')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsA._id.toString());
    expect(pubA.body.rooms.some((r) => r._id === roomBId)).toBe(false);

    // Socket message:send to RoomB by Alice is rejected
    const sockAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId: roomBId, text: 'Cross tenant attack' }, resolve);
    });
    expect(sockAck.ok).toBe(false);
  });
});
