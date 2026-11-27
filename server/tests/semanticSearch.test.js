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
import MessageEmbedding from '../src/models/MessageEmbedding.js';
import {
  indexMessageEmbedding,
  removeMessageEmbedding,
} from '../src/services/search/embeddingService.js';

describe('Sub-phase 12.1: Tenant-Isolated Semantic Search & Embeddings', () => {
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
      MessageEmbedding.syncIndexes(),
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
      MessageEmbedding.deleteMany({}),
    ]);
  });

  async function registerUser(app, username) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'StrongPassword123!' });
    expect(res.status).toBe(201);
    return { user: res.body.user, token: res.body.token };
  }

  it('ranks relevant messages and strictly isolates results by workspace and room membership', async () => {
    const app = createApp();
    const alice = await registerUser(app, 'SemAlice');
    const bob = await registerUser(app, 'SemBob');

    const wsA = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'SemOrgA' });
    const wsAId = wsA.body.workspace._id;

    // Add Bob to SemOrgA, but NOT to Alice's private room
    await WorkspaceMember.create({
      workspace: wsAId,
      user: bob.user.id,
      role: 'member',
      status: 'active',
    });

    const pubRoom = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsAId)
      .send({ name: 'PubSearch', type: 'public', memberIds: [bob.user.id] });
    const privRoom = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsAId)
      .send({ name: 'PrivSearch', type: 'private' });

    const pubMsg = await Message.create({
      workspace: wsAId,
      room: pubRoom.body.room._id,
      sender: alice.user.id,
      senderName: 'SemAlice',
      text: 'Kubernetes deployment rollback checklist for production',
    });
    const privMsg = await Message.create({
      workspace: wsAId,
      room: privRoom.body.room._id,
      sender: alice.user.id,
      senderName: 'SemAlice',
      text: 'Secret acquisition merger details confidential',
    });

    await indexMessageEmbedding(pubMsg.toObject());
    await indexMessageEmbedding(privMsg.toObject());

    // Alice (member of both) finds the private message
    const aliceRes = await request(app)
      .get('/api/v1/search/semantic?q=acquisition%20merger')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsAId);
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.body.results.some((r) => r.messageId === privMsg._id.toString())).toBe(true);

    // Bob (NOT a member of PrivSearch) must NEVER see privMsg
    const bobRes = await request(app)
      .get('/api/v1/search/semantic?q=acquisition%20merger')
      .set('Authorization', `Bearer ${bob.token}`)
      .set('X-Workspace-Id', wsAId);
    expect(bobRes.status).toBe(200);
    expect(bobRes.body.results.some((r) => r.messageId === privMsg._id.toString())).toBe(false);

    // Bob CAN find pubMsg
    const bobPubRes = await request(app)
      .get('/api/v1/search/semantic?q=kubernetes%20deployment')
      .set('Authorization', `Bearer ${bob.token}`)
      .set('X-Workspace-Id', wsAId);
    expect(bobPubRes.status).toBe(200);
    expect(bobPubRes.body.results[0].messageId).toBe(pubMsg._id.toString());

    // Deleting message removes its embedding from search results
    await removeMessageEmbedding(wsAId, pubMsg._id.toString());
    const afterDel = await request(app)
      .get('/api/v1/search/semantic?q=kubernetes%20deployment')
      .set('Authorization', `Bearer ${bob.token}`)
      .set('X-Workspace-Id', wsAId);
    expect(afterDel.body.results.some((r) => r.messageId === pubMsg._id.toString())).toBe(false);
  });

  it('blocks external embedding providers when allowExternalProcessing is false', async () => {
    const externalProvider = {
      name: 'openai',
      async embed() {
        throw new Error('Should not be called when allowExternalProcessing is false');
      },
    };
    const app = createApp();
    const alice = await registerUser(app, 'ExtAlice');
    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'NoExternalOrg' });
    const wsId = wsRes.body.workspace._id;

    const msg = await Message.create({
      workspace: wsId,
      room: new mongoose.Types.ObjectId(),
      sender: alice.user.id,
      senderName: 'ExtAlice',
      text: 'Sensitive internal data',
    });

    const res = await indexMessageEmbedding(msg.toObject(), { embeddingProvider: externalProvider });
    expect(res.skipped).toBe(true);
    expect(res.reason).toMatch(/allowExternalProcessing/i);
  });
});
