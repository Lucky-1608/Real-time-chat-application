import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import PushSubscription from '../src/models/PushSubscription.js';
import { createNotificationDispatcher } from '../src/services/notifications/notificationDispatcher.js';

describe('Phase 14: Web Push Subscriptions, Encrypted Keys & Email Digests', () => {
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
      PushSubscription.syncIndexes(),
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
      PushSubscription.deleteMany({}),
    ]);
  });

  it('encrypts push subscription keys at rest, rejects non-HTTPS endpoints, and supports unsubscribe', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'PushAlice', password: 'StrongPassword123!' });
    const token = reg.body.token;

    // Non-HTTPS endpoint rejected
    const badSub = await request(app)
      .post('/api/v1/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({
        endpoint: 'http://push.example.com/sub/123',
        keys: { p256dh: 'pub-key-1234567890', auth: 'auth-secret-1234' },
      });
    expect(badSub.status).toBe(400);

    // Valid HTTPS subscription stored with encrypted keys
    const okSub = await request(app)
      .post('/api/v1/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: { p256dh: 'pub-key-1234567890', auth: 'auth-secret-1234' },
      });
    expect(okSub.status).toBe(201);

    const doc = await PushSubscription.findOne({ user: reg.body.user.id }).lean();
    expect(doc).toBeTruthy();
    expect(doc.keysEnc).toBeTruthy();
    expect(doc.keysEnc).not.toContain('pub-key-1234567890');
    expect(doc.keysEnc).not.toContain('auth-secret-1234');

    // Unsubscribe removes it
    const unsub = await request(app)
      .delete('/api/v1/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' });
    expect(unsub.status).toBe(200);
    expect(await PushSubscription.countDocuments({ user: reg.body.user.id })).toBe(0);
  });

  it('respects DND/globalMute and allowExternalProcessing in push and email digest dispatchers', async () => {
    const pushProvider = { name: 'web-push', send: vi.fn(async () => ({ ok: true })) };
    const emailProvider = { name: 'smtp', send: vi.fn(async () => ({ ok: true })) };
    const dispatcher = createNotificationDispatcher({ pushProvider, emailProvider });

    const ws = await Workspace.create({
      name: 'ReachOrg',
      slug: 'reach-org',
      ownerId: new mongoose.Types.ObjectId(),
      settings: { allowExternalProcessing: false },
    });

    const user = await User.create({
      username: 'ReachBob',
      usernameLower: 'reachbob',
      passwordHash: 'hash',
      email: 'bob@example.com',
      dnd: { enabled: false },
      globalMute: false,
    });

    await PushSubscription.create({
      user: user._id,
      endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
      keysEnc: (await import('../src/services/cryptoService.js')).encryptField(
        JSON.stringify({ p256dh: 'k1', auth: 'a1' })
      ),
    });

    // Blocked when allowExternalProcessing is false
    const blockedPush = await dispatcher.sendPushToUser({
      workspaceId: ws._id.toString(),
      userId: user._id.toString(),
      title: 'New message',
      body: 'Hello',
    });
    expect(blockedPush.skipped).toBe(true);
    expect(pushProvider.send).not.toHaveBeenCalled();

    // Enable allowExternalProcessing -> push succeeds
    await Workspace.updateOne(
      { _id: ws._id },
      { $set: { 'settings.allowExternalProcessing': true } }
    );

    const okPush = await dispatcher.sendPushToUser({
      workspaceId: ws._id.toString(),
      userId: user._id.toString(),
      title: 'New message',
      body: 'Hello',
    });
    expect(okPush.sent).toBe(1);
    expect(pushProvider.send).toHaveBeenCalledTimes(1);

    // DND enabled -> push skipped
    await User.updateOne({ _id: user._id }, { $set: { 'dnd.enabled': true } });
    const dndPush = await dispatcher.sendPushToUser({
      workspaceId: ws._id.toString(),
      userId: user._id.toString(),
      title: 'New message',
      body: 'Hello again',
    });
    expect(dndPush.skipped).toBe(true);
    expect(pushProvider.send).toHaveBeenCalledTimes(1);

    // Email digest sends summary when user has email
    const digestRes = await dispatcher.sendEmailDigest({
      workspaceId: ws._id.toString(),
      userId: user._id.toString(),
      unreadCount: 3,
      roomNames: ['General'],
    });
    expect(digestRes.sent).toBe(true);
    expect(emailProvider.send).toHaveBeenCalledTimes(1);
  });
});
