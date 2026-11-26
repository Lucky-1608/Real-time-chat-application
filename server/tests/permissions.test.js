import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { can, PERMISSION_MATRIX, ROOM_ROLES } from '../src/services/permissions.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import AuditEvent from '../src/models/AuditEvent.js';

describe('Sub-phase 8.8: Roles & Central Permission Matrix', () => {
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
      AuditEvent.syncIndexes(),
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
      AuditEvent.deleteMany({}),
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

  it('enumerates the full (role, action) permission matrix accurately', () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const adminId = new mongoose.Types.ObjectId().toString();
    const modId = new mongoose.Types.ObjectId().toString();
    const memberId = new mongoose.Types.ObjectId().toString();
    const outsiderId = new mongoose.Types.ObjectId().toString();

    const room = {
      _id: new mongoose.Types.ObjectId(),
      type: 'private',
      members: [
        { user: ownerId, role: 'owner' },
        { user: adminId, role: 'admin' },
        { user: modId, role: 'moderator' },
        { user: memberId, role: 'member' },
      ],
    };

    const roleUserIds = {
      owner: ownerId,
      admin: adminId,
      moderator: modId,
      member: memberId,
    };

    const actions = Object.keys(PERMISSION_MATRIX);
    expect(actions.length).toBeGreaterThanOrEqual(8);

    for (const role of ROOM_ROLES) {
      const uid = roleUserIds[role];
      for (const action of actions) {
        const expected = PERMISSION_MATRIX[action].includes(role);
        const ctx = {
          room,
          message: { sender: uid },
          targetUser: { id: memberId, role: 'member' },
          targetRole: 'moderator',
        };
        if (action === 'member.remove' && role === 'member') {
          expect(can({ id: uid }, action, ctx)).toBe(false);
        } else if (action === 'ownership.transfer') {
          expect(can({ id: uid }, action, ctx)).toBe(role === 'owner');
        } else {
          expect(can({ id: uid }, action, ctx)).toBe(expected);
        }
      }
    }

    // Global admin does NOT automatically gain read access to private rooms or DMs
    expect(can({ id: outsiderId, globalRole: 'admin' }, 'room.read', { room })).toBe(false);
    expect(can({ id: outsiderId, globalRole: 'admin' }, 'admin.audit.read', {})).toBe(true);
    expect(can({ id: outsiderId, globalRole: 'user' }, 'admin.audit.read', {})).toBe(false);
  });

  it('blocks privilege-escalation attempts, enforces last-owner protection, and audits role changes', async () => {
    const { app, url } = await startServer();
    const owner = await registerUser(app, url, 'Owner');
    const admin = await registerUser(app, url, 'AdminUser');
    const mod = await registerUser(app, url, 'ModUser');
    const member = await registerUser(app, url, 'MemberUser');
    const globalAdmin = await registerUser(app, url, 'GlobalAdmin');
    await User.updateOne({ _id: globalAdmin.user.id }, { $set: { globalRole: 'admin' } });

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'PermRoom', type: 'private' });
    const roomId = roomRes.body.room._id;

    await request(app)
      .post(`/api/rooms/${roomId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ memberIds: [admin.user.id, mod.user.id, member.user.id] });

    // Global admin cannot read private room they are not a member of
    const globalReadRes = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${globalAdmin.token}`);
    expect(globalReadRes.status).toBe(404);

    // Owner promotes admin and mod; member:updated is broadcast
    const memberUpdatedPromise = new Promise((resolve) =>
      member.socket.once('member:updated', resolve)
    );
    const promoteAdminRes = await request(app)
      .patch(`/api/rooms/${roomId}/members/${admin.user.id}/role`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'admin' });
    expect(promoteAdminRes.status).toBe(200);
    const updatedEvt = await memberUpdatedPromise;
    expect(updatedEvt.userId).toBe(admin.user.id);
    expect(updatedEvt.role).toBe('admin');

    await request(app)
      .patch(`/api/rooms/${roomId}/members/${mod.user.id}/role`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'moderator' });

    // Privilege escalation: member tries to promote self to owner -> 403
    const selfPromoteRes = await request(app)
      .patch(`/api/rooms/${roomId}/members/${member.user.id}/role`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ role: 'owner' });
    expect(selfPromoteRes.status).toBe(403);

    // Privilege escalation: moderator tries to remove admin -> 403
    const modRemoveAdminRes = await request(app)
      .delete(`/api/rooms/${roomId}/members/${admin.user.id}`)
      .set('Authorization', `Bearer ${mod.token}`);
    expect(modRemoveAdminRes.status).toBe(403);

    // Privilege escalation: admin tries to demote owner -> 403
    const adminDemoteOwnerRes = await request(app)
      .patch(`/api/rooms/${roomId}/members/${owner.user.id}/role`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: 'member' });
    expect(adminDemoteOwnerRes.status).toBe(403);

    // Forged targetUser -> 404
    const forgedTargetRes = await request(app)
      .patch(`/api/rooms/${roomId}/members/${new mongoose.Types.ObjectId()}/role`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'moderator' });
    expect(forgedTargetRes.status).toBe(404);

    // Last owner cannot be demoted or leave
    const demoteSelfRes = await request(app)
      .patch(`/api/rooms/${roomId}/members/${owner.user.id}/role`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'member' });
    expect(demoteSelfRes.status).toBe(400);

    const ownerLeaveRes = await request(app)
      .delete(`/api/rooms/${roomId}/members/me`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ownerLeaveRes.status).toBe(400);

    // Ownership transfer succeeds and demotes previous owner to admin
    const transferRes = await request(app)
      .patch(`/api/rooms/${roomId}/members/${admin.user.id}/role`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'owner' });
    expect(transferRes.status).toBe(200);
    const updatedMembers = transferRes.body.room.members;
    expect(updatedMembers.find((m) => m.user.id === admin.user.id).role).toBe('owner');
    expect(updatedMembers.find((m) => m.user.id === owner.user.id).role).toBe('admin');

    // Audit events recorded for role changes
    const auditEvents = await AuditEvent.find({ action: 'room.role_change' }).lean();
    expect(auditEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('enforces that room/socket/admin handlers import the central permission layer', () => {
    const filesToCheck = [
      path.resolve('src/routes/rooms.js'),
      path.resolve('src/routes/uploads.js'),
      path.resolve('src/sockets/chatHandlers.js'),
      path.resolve('src/middleware/auth.js'),
    ];
    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toMatch(/permissions\.js/);
    }
  });
});
