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
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import WorkspaceInvite from '../src/models/WorkspaceInvite.js';
import { can } from '../src/services/permissions.js';

describe('Sub-phase 10.2: Workspace Permissions, Invites & Socket Isolation', () => {
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
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
      WorkspaceInvite.syncIndexes(),
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
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
      WorkspaceInvite.deleteMany({}),
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

  async function registerUser(app, username, email) {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password: 'password123', ...(email ? { email } : {}) });
    expect(res.status).toBe(201);
    return { user: res.body.user, token: res.body.token };
  }

  it('enforces workspace role matrix in can() and across workspace endpoints (including guest isolation)', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const memberId = new mongoose.Types.ObjectId().toString();
    const guestId = new mongoose.Types.ObjectId().toString();

    expect(can({ id: ownerId }, 'workspace.delete', { workspaceRole: 'owner' })).toBe(true);
    expect(can({ id: adminId }, 'workspace.delete', { workspaceRole: 'admin' })).toBe(false);
    expect(can({ id: adminId }, 'workspace.settings', { workspaceRole: 'admin' })).toBe(true);
    expect(can({ id: memberId }, 'workspace.settings', { workspaceRole: 'member' })).toBe(false);
    expect(can({ id: memberId }, 'workspace.rooms.browse', { workspaceRole: 'member' })).toBe(true);
    expect(can({ id: guestId }, 'workspace.rooms.browse', { workspaceRole: 'guest' })).toBe(false);
    expect(can({ id: guestId }, 'workspace.members.list', { workspaceRole: 'guest' })).toBe(false);

    const { app } = await startServer();
    const owner = await registerUser(app, 'OwnerUser');
    const guest = await registerUser(app, 'GuestUser');
    const member = await registerUser(app, 'MemberUser');

    // Create a new workspace as owner
    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Acme Corp', slug: 'acme-corp' });
    expect(wsRes.status).toBe(201);
    const wsId = wsRes.body.workspace._id;

    // Owner creates a public room and a private room in Acme Corp
    const pubRoom = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Workspace-Id', wsId)
      .send({ name: 'AcmePublic', type: 'public' });
    expect(pubRoom.status).toBe(201);

    const guestRoom = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Workspace-Id', wsId)
      .send({ name: 'GuestOnly', type: 'private', memberIds: [guest.user.id] });
    expect(guestRoom.status).toBe(201);

    // Add guest as 'guest' and member as 'member'
    await WorkspaceMember.create({ workspace: wsId, user: guest.user.id, role: 'guest', status: 'active' });
    await WorkspaceMember.create({ workspace: wsId, user: member.user.id, role: 'member', status: 'active' });

    // Guest CANNOT browse public rooms or join public rooms or list workspace members
    const guestBrowse = await request(app)
      .get('/api/v1/rooms/public')
      .set('Authorization', `Bearer ${guest.token}`)
      .set('X-Workspace-Id', wsId);
    expect(guestBrowse.status).toBe(403);

    const guestJoin = await request(app)
      .post(`/api/v1/rooms/${pubRoom.body.room._id}/join`)
      .set('Authorization', `Bearer ${guest.token}`)
      .set('X-Workspace-Id', wsId);
    expect(guestJoin.status).toBe(403);

    const guestUsers = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${guest.token}`)
      .set('X-Workspace-Id', wsId);
    expect(guestUsers.status).toBe(403);

    // Guest CAN access the private room they were explicitly added to
    const guestMsgs = await request(app)
      .get(`/api/v1/rooms/${guestRoom.body.room._id}/messages`)
      .set('Authorization', `Bearer ${guest.token}`)
      .set('X-Workspace-Id', wsId);
    expect(guestMsgs.status).toBe(200);

    // Member CAN browse public rooms and list workspace members, CANNOT update settings
    const memberBrowse = await request(app)
      .get('/api/v1/rooms/public')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Workspace-Id', wsId);
    expect(memberBrowse.status).toBe(200);

    const memberSettings = await request(app)
      .patch(`/api/v1/workspaces/${wsId}/settings`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ allowedInviteDomains: ['acme.com'] });
    expect(memberSettings.status).toBe(403);
  });

  it('enforces allowedInviteDomains and atomic single-use redemption on workspace invites', async () => {
    const { app } = await startServer();
    const owner = await registerUser(app, 'WsOwner');
    const alice = await registerUser(app, 'AliceAcme');
    const bob = await registerUser(app, 'BobAcme');
    const outsider = await registerUser(app, 'OutsiderEvil');

    await User.updateOne({ _id: alice.user.id }, { $set: { email: 'alice@acme.com' } });
    await User.updateOne({ _id: bob.user.id }, { $set: { email: 'bob@acme.com' } });
    await User.updateOne({ _id: outsider.user.id }, { $set: { email: 'eve@evil.com' } });

    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'DomainOrg', slug: 'domain-org' });
    const wsId = wsRes.body.workspace._id;

    // Restrict invite domains to acme.com
    const setRes = await request(app)
      .patch(`/api/v1/workspaces/${wsId}/settings`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ allowedInviteDomains: ['acme.com'] });
    expect(setRes.status).toBe(200);

    // Create single-use invite
    const invRes = await request(app)
      .post(`/api/v1/workspaces/${wsId}/invites`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ maxUses: 1, role: 'member' });
    expect(invRes.status).toBe(201);
    const token = invRes.body.token;

    // Outsider with @evil.com is blocked
    const evilRedeem = await request(app)
      .post(`/api/v1/workspaces/invites/${token}/redeem`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(evilRedeem.status).toBe(403);

    // Concurrent race between Alice (@acme.com) and Bob (@acme.com) for 1-use invite
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/v1/workspaces/invites/${token}/redeem`)
        .set('Authorization', `Bearer ${alice.token}`),
      request(app)
        .post(`/api/v1/workspaces/invites/${token}/redeem`)
        .set('Authorization', `Bearer ${bob.token}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 410]);
  });

  it('isolates presence to active workspace and supports workspace:switch without reconnecting', async () => {
    const { app, url } = await startServer();
    const alice = await registerUser(app, 'AliceWs');
    const bob = await registerUser(app, 'BobWs');

    const wsA = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Alpha', slug: 'alpha' });
    const wsB = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'Beta', slug: 'beta' });

    const wsAId = wsA.body.workspace._id;
    const wsBId = wsB.body.workspace._id;

    const alicePresenceEvents = [];
    const aliceSock = createClient(url, {
      transports: ['websocket'],
      auth: { token: alice.token, workspaceId: wsAId },
    });
    socketsToClose.push(aliceSock);
    aliceSock.on('presence:list', (list) => alicePresenceEvents.push(list));
    await new Promise((resolve, reject) => {
      aliceSock.once('connect', resolve);
      aliceSock.once('connect_error', reject);
    });

    const bobSock = createClient(url, {
      transports: ['websocket'],
      auth: { token: bob.token, workspaceId: wsBId },
    });
    socketsToClose.push(bobSock);
    await new Promise((resolve, reject) => {
      bobSock.once('connect', resolve);
      bobSock.once('connect_error', reject);
    });

    await new Promise((r) => setTimeout(r, 80));

    // Alice in Alpha must NEVER see Bob (who is only in Beta) in presence:list
    const allSeenUserIds = alicePresenceEvents.flat().map((u) => u.userId);
    expect(allSeenUserIds).not.toContain(bob.user.id);

    // Alice cannot switch to Beta (not a member)
    const deniedSwitch = await new Promise((resolve) => {
      aliceSock.emit('workspace:switch', { workspaceId: wsBId }, resolve);
    });
    expect(deniedSwitch.ok).toBe(false);

    // Add Alice to Beta and switch without reconnecting
    await WorkspaceMember.create({ workspace: wsBId, user: alice.user.id, role: 'member', status: 'active' });
    const okSwitch = await new Promise((resolve) => {
      aliceSock.emit('workspace:switch', { workspaceId: wsBId }, resolve);
    });
    expect(okSwitch.ok).toBe(true);
    expect(okSwitch.workspaceId).toBe(wsBId);
  });
});
