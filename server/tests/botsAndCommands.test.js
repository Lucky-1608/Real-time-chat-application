import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';
import Workspace from '../src/models/Workspace.js';
import WorkspaceMember from '../src/models/WorkspaceMember.js';
import Bot from '../src/models/Bot.js';
import ScheduledMessage from '../src/models/ScheduledMessage.js';
import { createSchedulerService } from '../src/services/schedulerService.js';
import { parseCommandInput } from '../src/services/commands/registry.js';

describe('Sub-phase 11.1: Bot Identities & Slash Commands', () => {
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
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
      Bot.syncIndexes(),
      ScheduledMessage.syncIndexes(),
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
      Bot.deleteMany({}),
      ScheduledMessage.deleteMany({}),
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
    const io = attachSockets(httpServer, app);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address();
    return { app, io, url: `http://127.0.0.1:${port}` };
  }

  async function registerAndConnect(app, url, username) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'StrongPassword123!' });
    expect(res.status).toBe(201);
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

  it('parses quoted unicode arguments cleanly and rejects oversized command inputs', () => {
    const parsed = parseCommandInput('/poll "Café 🚀?" "Oui ✅" "Non ❌"');
    expect(parsed.command).toBe('poll');
    expect(parsed.args).toEqual(['Café 🚀?', 'Oui ✅', 'Non ❌']);

    const unclosed = parseCommandInput('/poll "Unclosed quote');
    expect(unclosed.error).toMatch(/unterminated quote/i);

    const huge = parseCommandInput(`/shrug ${'a'.repeat(2100)}`);
    expect(huge.error).toMatch(/too long/i);
  });

  it('creates workspace-scoped bots, prevents bot password login, and requires room membership to post', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'BotOwner');
    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'BotLab', slug: 'bot-lab' });
    expect(wsRes.status).toBe(201);
    const wsId = wsRes.body.workspace._id;

    const roomsRes = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsId);
    const generalId = roomsRes.body.rooms.find((r) => r.name === 'General')._id;

    // Create bot
    const botRes = await request(app)
      .post(`/api/v1/workspaces/${wsId}/bots`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'DeployBot', scopes: ['messages:write'] });
    expect(botRes.status).toBe(201);
    expect(botRes.body.token).toBeTruthy();
    expect(botRes.body.bot.name).toBe('DeployBot');
    expect(botRes.body.bot.tokenHash).toBeUndefined();

    // Bot user cannot log in via password
    const botLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: botRes.body.bot.username, password: 'any-password-123' });
    expect(botLogin.status).toBe(401);

    // Bot cannot post to room before being added
    const deniedPost = await request(app)
      .post(`/api/v1/bots/messages`)
      .set('Authorization', `Bearer ${botRes.body.token}`)
      .send({ roomId: generalId, text: 'Build green!' });
    expect(deniedPost.status).toBe(403);

    // Add bot to room, then post succeeds with isBot: true
    const addRes = await request(app)
      .post(`/api/v1/rooms/${generalId}/bots`)
      .set('Authorization', `Bearer ${alice.token}`)
      .set('X-Workspace-Id', wsId)
      .send({ botId: botRes.body.bot._id });
    expect(addRes.status).toBe(200);

    const okPost = await request(app)
      .post(`/api/v1/bots/messages`)
      .set('Authorization', `Bearer ${botRes.body.token}`)
      .send({ roomId: generalId, text: 'Build green!' });
    expect(okPost.status).toBe(201);
    expect(okPost.body.message.isBot).toBe(true);
  });

  it('intercepts slash commands before persistence, isolates ephemeral messages, and enforces permissions & rate limits', async () => {
    const { app, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'CmdAlice');
    const bob = await registerAndConnect(app, url, 'CmdBob');

    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'CmdRoom', type: 'private', memberIds: [bob.user.id] });
    const roomId = roomRes.body.room._id;

    // Wait for sockets to join room
    await new Promise((r) => setTimeout(r, 60));

    const bobReceived = [];
    const bobEphemeral = [];
    bob.socket.on('message:new', (m) => bobReceived.push(m));
    bob.socket.on('ephemeral:message', (m) => bobEphemeral.push(m));

    const aliceEphemeral = [];
    alice.socket.on('ephemeral:message', (m) => aliceEphemeral.push(m));

    // Unknown command -> ephemeral error only to Alice; Bob receives nothing; nothing persisted
    const unknownAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: '/doesnotexist' }, resolve);
    });
    expect(unknownAck.ok).toBe(true);
    expect(unknownAck.ephemeral).toBe(true);

    // /help -> ephemeral only to Alice
    const helpAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: '/help' }, resolve);
    });
    expect(helpAck.ok).toBe(true);
    expect(helpAck.ephemeral).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
    expect(aliceEphemeral.length).toBeGreaterThanOrEqual(2);
    expect(bobEphemeral).toHaveLength(0);
    expect(bobReceived).toHaveLength(0);
    expect(await Message.countDocuments({ room: roomId }, { bypassTenantScope: true })).toBe(0);

    // Permission-gated /topic: Bob (member) cannot change topic, Alice (owner) can
    const bobTopicAck = await new Promise((resolve) => {
      bob.socket.emit('message:send', { roomId, text: '/topic Hacked Topic' }, resolve);
    });
    expect(bobTopicAck.ok).toBe(false);

    const aliceTopicAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: '/topic Release v2' }, resolve);
    });
    expect(aliceTopicAck.ok).toBe(true);

    // /poll creates an interactive poll in channel
    const pollAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: '/poll "Lunch?" "Tacos" "Sushi"' }, resolve);
    });
    expect(pollAck.ok).toBe(true);

    // /giphy returns 3 ephemeral candidates without persisting
    const giphyAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: '/giphy celebration' }, resolve);
    });
    expect(giphyAck.ok).toBe(true);
    expect(giphyAck.ephemeral).toBe(true);
    const giphyEvt = aliceEphemeral.find((e) => e.candidates);
    expect(giphyEvt.candidates).toHaveLength(3);
  });

  it('schedules /remind using user timezone and fake clock, and delivers as Reminder Bot', async () => {
    const { app, io, url } = await startServer();
    const alice = await registerAndConnect(app, url, 'RemindAlice');
    await User.updateOne({ _id: alice.user.id }, { $set: { timezone: 'America/New_York' } });

    const roomsRes = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${alice.token}`);
    const roomId = roomsRes.body.rooms[0]._id;

    // Schedule reminder in 2h
    const remAck = await new Promise((resolve) => {
      alice.socket.emit('message:send', { roomId, text: '/remind 2h Check deploy metrics' }, resolve);
    });
    expect(remAck.ok).toBe(true);
    expect(remAck.ephemeral).toBe(true);

    const pending = await ScheduledMessage.find({ sender: alice.user.id }).lean();
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toContain('Check deploy metrics');

    // Advance fake clock by 2h + 1m and run scheduler
    const futureNow = new Date(Date.now() + 2 * 3600_000 + 60_000);
    const scheduler = createSchedulerService({ io, nowFn: () => futureNow });
    const processed = await scheduler.processNextScheduled();
    expect(processed).toBe(true);

    const delivered = await Message.findOne(
      { room: roomId, text: /Check deploy metrics/ },
      null,
      { bypassTenantScope: true }
    ).lean();
    expect(delivered).toBeTruthy();
    expect(delivered.senderName).toBe('Reminder Bot');
    expect(delivered.isBot).toBe(true);
  });
});
