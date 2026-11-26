import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Session from '../src/models/Session.js';
import {
  checkBreachedPassword,
  createPasswordService,
} from '../src/services/passwordService.js';

describe('Sub-phase 8.3: Argon2id, Constant-Time Login, Backoff & HIBP', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([User.syncIndexes(), Room.syncIndexes(), Session.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Room.deleteMany({}), Session.deleteMany({})]);
  });

  it('hashes new passwords with argon2id and transparently rehashes legacy bcrypt users on login', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'ArgonUser', password: 'strong-password-10' });
    expect(reg.status).toBe(201);

    const argonUser = await User.findById(reg.body.user.id).lean();
    expect(argonUser.passwordHash.startsWith('$argon2id$')).toBe(true);

    // Seed a legacy bcrypt user
    const legacyHash = await bcrypt.hash('legacy-password-10', 10);
    await User.create({
      username: 'LegacyBob',
      usernameLower: 'legacybob',
      passwordHash: legacyHash,
    });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'LegacyBob', password: 'legacy-password-10' });
    expect(loginRes.status).toBe(200);

    const upgraded = await User.findOne({ usernameLower: 'legacybob' }).lean();
    expect(upgraded.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('executes dummy hash verification on unknown usernames for timing equivalence', async () => {
    const baseService = createPasswordService();
    const dummySpy = vi.spyOn(baseService, 'verifyDummyPassword');
    const app = createApp({ passwordService: baseService });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent_user', password: 'some-password-10' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');
    expect(dummySpy).toHaveBeenCalledTimes(1);
  });

  it('enforces per-account exponential backoff across different IPs and returns Retry-After', async () => {
    const app = createApp({
      authRateLimiter: (_req, _res, next) => next(), // isolate per-account backoff from IP limiter
    });

    await request(app)
      .post('/api/auth/register')
      .send({ username: 'TargetUser', password: 'correct-password-10' });

    // 5 failed attempts from 5 distinct IPs
    for (let i = 1; i <= 5; i++) {
      const fail = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ username: 'TargetUser', password: 'wrong-password-10' });
      expect(fail.status).toBe(401);
      expect(fail.body.error).toBe('Invalid username or password');
      if (i === 5) {
        expect(Number(fail.headers['retry-after'])).toBeGreaterThanOrEqual(25);
      }
    }

    // 6th attempt from yet another IP is still delayed with Retry-After and generic 401
    const lockedRes = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.99')
      .send({ username: 'TargetUser', password: 'correct-password-10' });
    expect(lockedRes.status).toBe(401);
    expect(lockedRes.body.error).toBe('Invalid username or password');
    expect(Number(lockedRes.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects breached passwords via HIBP range API and fails open when HIBP is unavailable', async () => {
    const breachedPw = 'password12345';
    const sha1 = crypto.createHash('sha1').update(breachedPw).digest('hex').toUpperCase();
    const suffix = sha1.slice(5);

    const mockFetchBreached = vi.fn(async (_url, opts) => {
      expect(opts.headers['Add-Padding']).toBe('true');
      return {
        ok: true,
        text: async () => `00000000000000000000000000000000000:2\n${suffix}:42\n`,
      };
    });

    await expect(
      checkBreachedPassword(breachedPw, { fetchFn: mockFetchBreached })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Fail-open when HIBP times out or errors
    const mockFetchDown = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      checkBreachedPassword(breachedPw, { fetchFn: mockFetchDown })
    ).resolves.toBeUndefined();
  });

  it('changes password, requires current password, and revokes all other sessions', async () => {
    const app = createApp();
    const s1 = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'initial-password-10' });
    const s2 = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Alice', password: 'initial-password-10' });

    const wrongCur = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${s1.body.token}`)
      .send({ currentPassword: 'wrong-password-10', newPassword: 'brand-new-password-10' });
    expect(wrongCur.status).toBe(401);

    const okChange = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${s1.body.token}`)
      .send({ currentPassword: 'initial-password-10', newPassword: 'brand-new-password-10' });
    expect(okChange.status).toBe(200);

    // Current session s1 still works; other session s2 is revoked
    const s1Check = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${s1.body.token}`);
    expect(s1Check.status).toBe(200);

    const s2Check = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${s2.body.token}`);
    expect(s2Check.status).toBe(401);
  });
});
