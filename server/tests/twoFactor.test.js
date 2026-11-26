import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { generateSync } from 'otplib';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Session from '../src/models/Session.js';

describe('Sub-phase 8.4: Two-Factor Authentication (TOTP) & Recovery Codes', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

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

  afterEach(async () => {
    for (const sock of socketsToClose.splice(0)) {
      if (sock.connected) sock.disconnect();
    }
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  async function startServer() {
    const app = createApp({ authRateLimiter: (_req, _res, next) => next() });
    const httpServer = http.createServer(app);
    serversToClose.push(httpServer);
    attachSockets(httpServer, app);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, url: `http://127.0.0.1:${port}` };
  }

  it('completes 2FA setup, login-with-2FA, rejects TOTP replay, and enforces single-use recovery codes', async () => {
    const { app, url } = await startServer();

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'Alice2FA', password: 'strong-password-10' });
    const token = reg.body.token;

    // 1. Setup 2FA
    const setupRes = await request(app)
      .post('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`);
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.otpauthUri).toContain('otpauth://totp/');
    expect(setupRes.body.qrDataUrl).toContain('data:image/png;base64,');
    const secret = setupRes.body.secret;

    // Verify encrypted at rest in DB (plaintext secret never stored)
    const dbUserBefore = await User.findById(reg.body.user.id).lean();
    expect(dbUserBefore.twoFactorPendingSecretEnc).toMatch(/^k1:/);
    expect(dbUserBefore.twoFactorPendingSecretEnc).not.toContain(secret);

    // 2. Enable 2FA with valid TOTP code
    const code1 = generateSync({ secret });
    const enableRes = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: code1 });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.recoveryCodes).toHaveLength(10);

    // 3. Login now returns mfaRequired + pending token, NOT a session
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Alice2FA', password: 'strong-password-10' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.mfaRequired).toBe(true);
    expect(typeof loginRes.body.mfaToken).toBe('string');
    expect(loginRes.body.token).toBeUndefined();

    // Pending token cannot call protected REST routes or connect a socket
    const restWithPending = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${loginRes.body.mfaToken}`);
    expect(restWithPending.status).toBe(401);

    const sockPending = createClient(url, {
      transports: ['websocket'],
      auth: { token: loginRes.body.mfaToken },
    });
    socketsToClose.push(sockPending);
    const sockErr = await new Promise((resolve) => sockPending.once('connect_error', resolve));
    expect(sockErr.message).toBe('unauthorized');

    // 4. Replaying the same TOTP code used during enable (same time step) MUST fail
    const replayRes = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ mfaToken: loginRes.body.mfaToken, code: code1 });
    expect(replayRes.status).toBe(401);

    // 5. Recovery code works ONCE, then fails on reuse
    const recoveryCode = enableRes.body.recoveryCodes[0];
    const recVerify = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ mfaToken: loginRes.body.mfaToken, recoveryCode });
    expect(recVerify.status).toBe(200);
    expect(typeof recVerify.body.token).toBe('string');
    expect(recVerify.body.user.twoFactorSecretEnc).toBeUndefined();
    expect(recVerify.body.user.recoveryCodeHashes).toBeUndefined();

    // Reusing the same recovery code fails
    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Alice2FA', password: 'strong-password-10' });
    const recReuse = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ mfaToken: login2.body.mfaToken, recoveryCode });
    expect(recReuse.status).toBe(401);

    // 6. Brute-force 2FA failures trigger exponential backoff
    for (let i = 0; i < 5; i++) {
      const bad = await request(app)
        .post('/api/auth/2fa/verify')
        .send({ mfaToken: login2.body.mfaToken, code: '000000' });
      expect(bad.status).toBe(401);
    }
    const locked = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ mfaToken: login2.body.mfaToken, recoveryCode: enableRes.body.recoveryCodes[1] });
    expect(locked.status).toBe(401);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });
});
