import { Writable } from 'node:stream';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/services/logger.js';
import { scrubSentryEvent } from '../src/services/sentryService.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import FeatureFlag from '../src/models/FeatureFlag.js';

describe('Sub-phase 9.4: Observability, Metrics, Readiness & Feature Flags', () => {
  let mongoServer;
  const serversToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([User.syncIndexes(), Room.syncIndexes(), FeatureFlag.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Room.deleteMany({}),
      FeatureFlag.deleteMany({}),
    ]);
  });

  afterEach(async () => {
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('logs structured JSON with requestId and redacts authorization, cookies, passwords, tokens, and message text', () => {
    const lines = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });

    const log = createLogger({ destination: stream, level: 'info' });
    log.info(
      {
        requestId: 'req-123',
        req: { headers: { authorization: 'Bearer supersecret', cookie: 'refreshToken=abc' } },
        password: 'MyPassword123',
        token: 'jwt-secret-token',
        text: 'Private chat message body',
      },
      'request completed'
    );

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.requestId).toBe('req-123');
    expect(parsed.req.headers.authorization).toBe('[Redacted]');
    expect(parsed.req.headers.cookie).toBe('[Redacted]');
    expect(parsed.password).toBe('[Redacted]');
    expect(parsed.token).toBe('[Redacted]');
    expect(parsed.text).toBe('[Redacted]');
  });

  it('scrubs PII from Sentry events and protects /metrics behind admin auth', async () => {
    const scrubbed = scrubSentryEvent({
      request: { headers: { authorization: 'Bearer xyz', cookie: 'a=b' } },
      user: { id: '1', email: 'alice@example.com' },
      extra: { text: 'secret chat', token: 'abc' },
    });
    expect(scrubbed.request.headers.authorization).toBe('[Redacted]');
    expect(scrubbed.user.email).toBeUndefined();
    expect(scrubbed.extra.text).toBe('[Redacted]');
    expect(scrubbed.extra.token).toBe('[Redacted]');

    const app = createApp();
    const userRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'NormalUser', password: 'StrongPassword123' });
    const adminRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'AdminUser', password: 'StrongPassword123' });
    await User.updateOne({ _id: adminRes.body.user.id }, { $set: { globalRole: 'admin' } });

    const nonAdminMetrics = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${userRes.body.token}`);
    expect(nonAdminMetrics.status).toBe(403);

    const adminMetrics = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${adminRes.body.token}`);
    expect(adminMetrics.status).toBe(200);
    expect(adminMetrics.text).toContain('chat_http_request_duration_seconds');
    expect(adminMetrics.text).toContain('chat_active_sockets');
  });

  it('returns 503 on /ready when MongoDB is disconnected and enforces runtime feature flag toggles', async () => {
    const app = createApp();
    const adminRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'FlagAdmin', password: 'StrongPassword123' });
    await User.updateOne({ _id: adminRes.body.user.id }, { $set: { globalRole: 'admin' } });

    const roomRes = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminRes.body.token}`)
      .send({ name: 'FlagRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    // Default config has polls enabled
    const cfgBefore = await request(app).get('/api/v1/config');
    expect(cfgBefore.status).toBe(200);
    expect(cfgBefore.body.flags.polls).toBe(true);

    // Admin disables polls flag
    const toggleRes = await request(app)
      .patch('/api/admin/flags')
      .set('Authorization', `Bearer ${adminRes.body.token}`)
      .send({ flag: 'polls', enabled: false });
    expect(toggleRes.status).toBe(200);

    const cfgAfter = await request(app).get('/api/v1/config');
    expect(cfgAfter.body.flags.polls).toBe(false);

    // Creating a poll now returns 403
    const blockedPoll = await request(app)
      .post(`/api/rooms/${roomId}/polls`)
      .set('Authorization', `Bearer ${adminRes.body.token}`)
      .send({ question: 'Disabled?', options: ['Yes', 'No'] });
    expect(blockedPoll.status).toBe(403);

    // Readiness succeeds while connected, then returns 503 when disconnected
    const readyOk = await request(app).get('/ready');
    expect(readyOk.status).toBe(200);

    await mongoose.disconnect();
    const readyDown = await request(app).get('/ready');
    expect(readyDown.status).toBe(503);

    await mongoose.connect(mongoServer.getUri());
  });
});
