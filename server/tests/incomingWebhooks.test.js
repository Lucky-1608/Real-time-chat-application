import crypto from 'node:crypto';
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
import IncomingWebhook from '../src/models/IncomingWebhook.js';
import WebhookDelivery from '../src/models/WebhookDelivery.js';
import WebhookIdempotency from '../src/models/WebhookIdempotency.js';

describe('Sub-phase 11.2: Incoming Webhooks, GitHub HMAC & Idempotency', () => {
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
      IncomingWebhook.syncIndexes(),
      WebhookDelivery.syncIndexes(),
      WebhookIdempotency.syncIndexes(),
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
      IncomingWebhook.deleteMany({}),
      WebhookDelivery.deleteMany({}),
      WebhookIdempotency.deleteMany({}),
    ]);
  });

  async function registerAndCreateWorkspaceRoom(app, username, wsName) {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'StrongPassword123!' });
    const token = reg.body.token;

    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: wsName });
    const wsId = wsRes.body.workspace._id;

    const roomsRes = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', wsId);
    const roomId = roomsRes.body.rooms.find((r) => r.name === 'General')._id;

    return { user: reg.body.user, token, wsId, roomId };
  }

  it('rejects bad/missing/rotated/revoked tokens, unknown fields, and >64KB payloads', async () => {
    const app = createApp();
    const alice = await registerAndCreateWorkspaceRoom(app, 'HookAlice', 'HookOrg');
    const bob = await registerAndCreateWorkspaceRoom(app, 'HookBob', 'OtherOrg');

    // Bob (not in Alice's workspace/room) cannot create a webhook on Alice's room
    const crossWsCreate = await request(app)
      .post(`/api/v1/rooms/${alice.roomId}/webhooks`)
      .set('Authorization', `Bearer ${bob.token}`)
      .set('X-Workspace-Id', bob.wsId)
      .send({ name: 'CrossHook', formatter: 'generic' });
    expect(crossWsCreate.status).toBe(404);

    // Alice creates generic webhook
    const createRes = await request(app)
      .post(`/api/v1/rooms/${alice.roomId}/webhooks`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', alice.wsId)
      .send({ name: 'CI Alerts', formatter: 'generic' });
    expect(createRes.status).toBe(201);
    const hookId = createRes.body.webhook._id;
    const rawToken = createRes.body.token;
    expect(rawToken).toBeTruthy();

    // Bad token -> 401
    const badTok = await request(app)
      .post(`/api/v1/hooks/${hookId}/wrong-token-value-123456`)
      .send({ text: 'Hello' });
    expect(badTok.status).toBe(401);

    // Unknown field -> 400
    const unknownField = await request(app)
      .post(`/api/v1/hooks/${hookId}/${rawToken}`)
      .send({ text: 'Hello', extraMaliciousField: true });
    expect(unknownField.status).toBe(400);

    // Unsafe javascript: URL in attachment -> 400
    const badAtt = await request(app)
      .post(`/api/v1/hooks/${hookId}/${rawToken}`)
      .send({
        text: 'Check link',
        attachments: [{ title: 'Click', text: 'xss', url: 'javascript:alert(1)' }],
      });
    expect(badAtt.status).toBe(400);

    // Oversized >64KB body -> 413
    const hugeBody = await request(app)
      .post(`/api/v1/hooks/${hookId}/${rawToken}`)
      .send({ text: 'a'.repeat(70 * 1024) });
    expect(hugeBody.status).toBe(413);

    // Rotate token -> old token stops working, new token works
    const rotRes = await request(app)
      .post(`/api/v1/rooms/${alice.roomId}/webhooks/${hookId}/rotate`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', alice.wsId);
    expect(rotRes.status).toBe(200);
    const newToken = rotRes.body.token;
    expect(newToken).not.toBe(rawToken);

    const oldTokAfterRotate = await request(app)
      .post(`/api/v1/hooks/${hookId}/${rawToken}`)
      .send({ text: 'Old token' });
    expect(oldTokAfterRotate.status).toBe(401);

    const newTokOk = await request(app)
      .post(`/api/v1/hooks/${hookId}/${newToken}`)
      .send({ text: 'New token works <script>alert(1)</script>' });
    expect(newTokOk.status).toBe(201);
    expect(newTokOk.body.message.isBot).toBe(true);
    expect(newTokOk.body.message.senderName).toBe('CI Alerts');

    // Revoke webhook -> 401
    const revokeRes = await request(app)
      .delete(`/api/v1/rooms/${alice.roomId}/webhooks/${hookId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', alice.wsId);
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await request(app)
      .post(`/api/v1/hooks/${hookId}/${newToken}`)
      .send({ text: 'After revoke' });
    expect(afterRevoke.status).toBe(401);
  });

  it('verifies X-Hub-Signature-256 for GitHub webhooks, honors Idempotency-Key, and enforces rate limits', async () => {
    const app = createApp();
    const alice = await registerAndCreateWorkspaceRoom(app, 'GhAlice', 'GhOrg');

    const createRes = await request(app)
      .post(`/api/v1/rooms/${alice.roomId}/webhooks`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', alice.wsId)
      .send({ name: 'GitHub', formatter: 'github' });
    expect(createRes.status).toBe(201);
    const { webhook, token, signingSecret } = createRes.body;
    expect(signingSecret).toBeTruthy();

    const ghPayload = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/chat' },
      pusher: { name: 'octocat' },
      commits: [{ id: 'abc1234', message: 'Fix auth' }],
    });

    // Missing or invalid signature -> 401
    const noSig = await request(app)
      .post(`/api/v1/hooks/${webhook._id}/${token}`)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .send(ghPayload);
    expect(noSig.status).toBe(401);

    const badSig = await request(app)
      .post(`/api/v1/hooks/${webhook._id}/${token}`)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
      .send(ghPayload);
    expect(badSig.status).toBe(401);

    // Valid signature + Idempotency-Key
    const validSig = `sha256=${crypto.createHmac('sha256', signingSecret).update(ghPayload).digest('hex')}`;
    const ok1 = await request(app)
      .post(`/api/v1/hooks/${webhook._id}/${token}`)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', validSig)
      .set('Idempotency-Key', 'gh-delivery-1')
      .send(ghPayload);
    expect(ok1.status).toBe(201);
    expect(ok1.body.message.text).toContain('acme/chat');

    // Replay with same Idempotency-Key -> deduplicated without creating a 2nd message
    const ok2 = await request(app)
      .post(`/api/v1/hooks/${webhook._id}/${token}`)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', validSig)
      .set('Idempotency-Key', 'gh-delivery-1')
      .send(ghPayload);
    expect(ok2.status).toBe(200);
    expect(ok2.body.deduplicated).toBe(true);

    const msgCount = await Message.countDocuments(
      { workspace: alice.wsId, room: alice.roomId },
      { bypassTenantScope: true }
    );
    expect(msgCount).toBe(1);

    // Per-webhook rate limit kicks in after burst (e.g. >30 req/min)
    let hit429 = false;
    for (let i = 0; i < 35; i++) {
      const r = await request(app)
        .post(`/api/v1/hooks/${webhook._id}/${token}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'push')
        .set('X-Hub-Signature-256', validSig)
        .send(ghPayload);
      if (r.status === 429) {
        hit429 = true;
        break;
      }
    }
    expect(hit429).toBe(true);
  });
});
