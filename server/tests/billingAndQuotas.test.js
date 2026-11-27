import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import BillingEvent from '../src/models/BillingEvent.js';
import AuditEvent from '../src/models/AuditEvent.js';
import { assertWorkspaceQuota } from '../src/services/billing/plans.js';
import { createMockPaymentProvider } from '../src/services/providers/paymentProvider.js';

describe('Phase 15: Plans, Quotas & Signed Billing Webhooks', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      User.syncIndexes(),
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
      BillingEvent.syncIndexes(),
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
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
      BillingEvent.deleteMany({}),
      AuditEvent.deleteMany({}),
    ]);
  });

  it('rejects forged/expired billing webhooks, upgrades plan on valid HMAC, and deduplicates replays', async () => {
    const webhookSecret = 'whsec_test_billing_secret';
    const paymentProvider = createMockPaymentProvider({ webhookSecret });
    const app = createApp({ paymentProvider });

    const owner = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'BillOwner', password: 'StrongPassword123!' });
    const member = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'BillMember', password: 'StrongPassword123!' });

    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.body.token}`)
      .send({ name: 'BillingOrg' });
    const wsId = wsRes.body.workspace._id;

    await WorkspaceMember.create({
      workspace: wsId,
      user: member.body.user.id,
      role: 'member',
      status: 'active',
    });

    // Non-owner cannot start checkout
    const memberCheckout = await request(app)
      .post(`/api/v1/workspaces/${wsId}/billing/checkout`)
      .set('Authorization', `Bearer ${member.body.token}`)
      .send({ plan: 'pro' });
    expect(memberCheckout.status).toBe(403);

    // Owner starts checkout
    const ownerCheckout = await request(app)
      .post(`/api/v1/workspaces/${wsId}/billing/checkout`)
      .set('Authorization', `Bearer ${owner.body.token}`)
      .send({ plan: 'pro' });
    expect(ownerCheckout.status).toBe(200);
    expect(ownerCheckout.body.checkoutUrl).toContain('https://');

    // Quota check on free plan blocks 11th member
    expect(() => assertWorkspaceQuota({ plan: 'free' }, 'members', 10)).toThrow(/quota|limit/i);

    const eventPayload = JSON.stringify({
      id: 'evt_test_12345',
      type: 'checkout.session.completed',
      data: { object: { metadata: { workspaceId: wsId, plan: 'pro' } } },
    });

    // Forged signature rejected with 401
    const forged = await request(app)
      .post('/api/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${Math.floor(Date.now() / 1000)},v1=0000`)
      .send(eventPayload);
    expect(forged.status).toBe(401);

    // Valid signature upgrades workspace plan to 'pro'
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${ts}.${eventPayload}`)
      .digest('hex');

    const okWebhook = await request(app)
      .post('/api/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${ts},v1=${sig}`)
      .send(eventPayload);
    expect(okWebhook.status).toBe(200);
    expect(okWebhook.body.processed).toBe(true);

    const updatedWs = await Workspace.findById(wsId).lean();
    expect(updatedWs.plan).toBe('pro');
    expect(() => assertWorkspaceQuota(updatedWs, 'members', 10)).not.toThrow();

    // Replay same event.id -> deduplicated
    const replay = await request(app)
      .post('/api/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${ts},v1=${sig}`)
      .send(eventPayload);
    expect(replay.status).toBe(200);
    expect(replay.body.deduplicated).toBe(true);

    const auditEvt = await AuditEvent.findOne({ action: 'billing.plan_changed' }).lean();
    expect(auditEvt).toBeTruthy();
  });
});
