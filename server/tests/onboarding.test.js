import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';

describe('Sub-phase 10.3: Workspace Onboarding, Welcome Bot, Tour State & Demo Content', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      User.syncIndexes(),
      Room.syncIndexes(),
      Message.syncIndexes(),
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
      Message.deleteMany({}),
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
    ]);
  });

  async function registerUser(app, username) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'StrongPassword123!' });
    expect(res.status).toBe(201);
    return { user: res.body.user, token: res.body.token };
  }

  it('seeds #General, #random, and a Welcome Bot DM on workspace creation, and blocks Welcome Bot login', async () => {
    const app = createApp();
    const owner = await registerUser(app, 'OnboardOwner');

    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Starter Co', slug: 'starter-co' });
    expect(wsRes.status).toBe(201);
    const wsId = wsRes.body.workspace._id;

    const roomsRes = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Workspace-Id', wsId);
    expect(roomsRes.status).toBe(200);

    const names = roomsRes.body.rooms.map((r) => r.name);
    expect(names).toContain('General');
    expect(names).toContain('random');

    const welcomeDm = roomsRes.body.rooms.find(
      (r) => r.type === 'dm' && r.otherUser?.username === 'Welcome Bot'
    );
    expect(welcomeDm).toBeTruthy();

    const dmMsgs = await request(app)
      .get(`/api/v1/rooms/${welcomeDm._id}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Workspace-Id', wsId);
    expect(dmMsgs.status).toBe(200);
    expect(dmMsgs.body.messages.length).toBeGreaterThanOrEqual(1);
    expect(dmMsgs.body.messages[0].text).toMatch(/Welcome/i);

    // Welcome Bot is a system user and must NEVER be able to log in
    const botUser = await User.findOne({ usernameLower: 'welcome bot' }).lean();
    expect(botUser.isSystem).toBe(true);

    const botLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'Welcome Bot', password: 'any-password-123' });
    expect(botLogin.status).toBe(401);
  });

  it('persists per-user onboarding tour progress and supports adding/removing demo content', async () => {
    const app = createApp();
    const owner = await registerUser(app, 'TourUser');
    const outsider = await registerUser(app, 'OutsiderUser');

    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Demo Org', slug: 'demo-org' });
    const wsId = wsRes.body.workspace._id;

    // Initial onboarding state
    const get1 = await request(app)
      .get('/api/v1/users/me/onboarding')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(get1.status).toBe(200);
    expect(get1.body.onboarding.tourStep).toBe(0);
    expect(get1.body.onboarding.tourCompleted).toBe(false);

    // Update tour step and completedSteps
    const patchRes = await request(app)
      .patch('/api/v1/users/me/onboarding')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ tourStep: 2, completedSteps: ['create_room', 'send_message'] });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.onboarding.tourStep).toBe(2);
    expect(patchRes.body.onboarding.completedSteps).toEqual(['create_room', 'send_message']);

    // Outsider cannot add demo content to owner's workspace
    const deniedDemo = await request(app)
      .post(`/api/v1/workspaces/${wsId}/demo`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(deniedDemo.status).toBe(404);

    // Owner adds demo content -> creates demo-playground room with seeded messages
    const addDemo = await request(app)
      .post(`/api/v1/workspaces/${wsId}/demo`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(addDemo.status).toBe(201);
    expect(addDemo.body.room.name).toBe('demo-playground');
    expect(addDemo.body.messageCount).toBeGreaterThanOrEqual(3);

    // One-click remove demo content deletes room & messages
    const delDemo = await request(app)
      .delete(`/api/v1/workspaces/${wsId}/demo`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(delDemo.status).toBe(200);
    expect(delDemo.body.removed).toBe(true);

    const remainingDemo = await Room.findOne(
      { workspace: wsId, nameLower: 'demo-playground' },
      null,
      { bypassTenantScope: true }
    ).lean();
    expect(remainingDemo).toBeNull();
  });
});
