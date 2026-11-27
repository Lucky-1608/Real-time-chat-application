import http from 'node:http';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import AuditEvent from '../src/models/AuditEvent.js';
import OutgoingWebhook from '../src/models/OutgoingWebhook.js';
import OutgoingDeliveryJob from '../src/models/OutgoingDeliveryJob.js';
import { isBlockedIp, safeWebhookRequest, validateWebhookUrl } from '../src/services/security/ssrfGuard.js';
import {
  createOutgoingDispatcher,
  signOutgoingPayload,
} from '../src/services/webhooks/outgoingDispatcher.js';

describe('Sub-phase 11.3: Outgoing Webhooks & SSRF Defense', () => {
  let mongoServer;
  const serversToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      User.syncIndexes(),
      Room.syncIndexes(),
      Message.syncIndexes(),
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
      AuditEvent.syncIndexes(),
      OutgoingWebhook.syncIndexes(),
      OutgoingDeliveryJob.syncIndexes(),
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
      AuditEvent.deleteMany({}),
      OutgoingWebhook.deleteMany({}),
      OutgoingDeliveryJob.deleteMany({}),
    ]);
  });

  afterEach(async () => {
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('blocks private/reserved IPv4, IPv6, IPv4-mapped IPv6, non-HTTPS URLs, DNS rebinding, and redirects', async () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('172.16.5.4')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('100.64.0.1')).toBe(true);
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('93.184.216.34')).toBe(false);

    // Non-HTTPS rejected by default
    await expect(
      validateWebhookUrl('http://example.com/hook', {
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      })
    ).rejects.toThrow(/HTTPS/i);

    // Private IP returned by DNS rejected
    await expect(
      validateWebhookUrl('https://metadata.internal/hook', {
        lookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
      })
    ).rejects.toThrow(/blocked/i);

    // DNS rebinding defense: 1st lookup returns public IP, 2nd would return 127.0.0.1.
    // validateWebhookUrl resolves ONCE and pins the IP; redirect server test verifies 302 is blocked.
    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    serversToClose.push(redirectServer);
    await new Promise((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    const { port } = redirectServer.address();

    // Even when allowHttp + allowPrivateForTest are enabled for local test server, 3xx redirects are blocked!
    await expect(
      safeWebhookRequest(
        `http://127.0.0.1:${port}/redirect`,
        { method: 'POST', body: '{}' },
        { allowHttp: true, allowPrivateIp: true }
      )
    ).rejects.toThrow(/redirect/i);
  });

  it('rejects SSRF URLs on outgoing webhook creation via REST API', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'OutOwner', password: 'StrongPassword123!' });
    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: 'OutOrg' });
    const wsId = wsRes.body.workspace._id;

    const badLocal = await request(app)
      .post(`/api/v1/workspaces/${wsId}/outgoing-webhooks`)
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ url: 'https://127.0.0.1/hook', events: ['message.created'] });
    expect(badLocal.status).toBe(400);

    const badMeta = await request(app)
      .post(`/api/v1/workspaces/${wsId}/outgoing-webhooks`)
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ url: 'http://169.254.169.254/latest', events: ['message.created'] });
    expect(badMeta.status).toBe(400);
  });

  it('delivers signed events with dedupe headers, isolates by workspace/room, and dead-letters + auto-disables after 6 failures', async () => {
    const received = [];
    let shouldFail = false;
    const receiverServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (shouldFail) {
          res.writeHead(500);
          res.end('boom');
          return;
        }
        received.push({
          headers: req.headers,
          rawBody: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200);
        res.end('ok');
      });
    });
    serversToClose.push(receiverServer);
    await new Promise((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
    const { port } = receiverServer.address();

    const wsAId = new mongoose.Types.ObjectId();
    const wsBId = new mongoose.Types.ObjectId();
    const room1Id = new mongoose.Types.ObjectId();
    const room2Id = new mongoose.Types.ObjectId();

    const { encryptField } = await import('../src/services/cryptoService.js');
    const secret = 'whsec_test_secret_123456';

    const hookA = await OutgoingWebhook.create({
      workspace: wsAId,
      room: room1Id,
      url: `http://127.0.0.1:${port}/receive`,
      events: ['message.created'],
      signingSecretEnc: encryptField(secret),
      enabled: true,
    });

    // Different workspace webhook — must NEVER receive events from wsAId
    await OutgoingWebhook.create({
      workspace: wsBId,
      room: room2Id,
      url: `http://127.0.0.1:${port}/other-ws`,
      events: ['message.created'],
      signingSecretEnc: encryptField(secret),
      enabled: true,
    });

    let fakeNow = new Date('2026-06-01T12:00:00.000Z');
    const dispatcher = createOutgoingDispatcher({
      nowFn: () => fakeNow,
      requestOptions: { allowHttp: true, allowPrivateIp: true },
    });

    // Dispatch event in wsAId / room2Id -> hookA is scoped to room1Id, so 0 jobs created
    const jobsRoom2 = await dispatcher.enqueueEvent({
      workspaceId: wsAId.toString(),
      roomId: room2Id.toString(),
      event: 'message.created',
      payload: { text: 'Room 2 secret' },
    });
    expect(jobsRoom2).toBe(0);

    // Dispatch event in wsAId / room1Id -> 1 job created and delivered with valid HMAC
    const jobsRoom1 = await dispatcher.enqueueEvent({
      workspaceId: wsAId.toString(),
      roomId: room1Id.toString(),
      event: 'message.created',
      payload: { messageId: 'm1', text: 'Hello hook', senderId: 'u1', senderName: 'Alice' },
    });
    expect(jobsRoom1).toBe(1);

    await dispatcher.processNextDelivery();
    expect(received).toHaveLength(1);
    const sigHeader = received[0].headers['x-pulsechat-signature-256'];
    expect(sigHeader).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(received[0].headers['x-pulsechat-delivery']).toBeTruthy();
    expect(received[0].headers['x-pulsechat-event-id']).toBeTruthy();

    const ts = sigHeader.split(',')[0].slice(2);
    const v1 = sigHeader.split(',')[1].slice(3);
    const expectedSig = signOutgoingPayload(secret, ts, received[0].rawBody);
    expect(crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expectedSig))).toBe(true);

    // Sustained failures (6 attempts) -> dead_letter + auto-disable + audit event
    shouldFail = true;
    await dispatcher.enqueueEvent({
      workspaceId: wsAId.toString(),
      roomId: room1Id.toString(),
      event: 'message.created',
      payload: { messageId: 'm2', text: 'Will fail' },
    });

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      fakeNow = new Date(fakeNow.getTime() + 120_000);
      await dispatcher.processNextDelivery();
    }

    const deadJob = await OutgoingDeliveryJob.findOne({ status: 'dead_letter' }).lean();
    expect(deadJob).toBeTruthy();
    expect(deadJob.attempts).toBe(6);

    const updatedHook = await OutgoingWebhook.findById(hookA._id).lean();
    expect(updatedHook.enabled).toBe(false);

    const auditEvt = await AuditEvent.findOne({ action: 'webhook.outgoing.auto_disabled' }).lean();
    expect(auditEvt).toBeTruthy();
  });
});
