import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import { Adapter } from 'socket.io-adapter';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/sockets/index.js';
import { generateOpenApiDocument } from '../src/services/openapi.js';
import User from '../src/models/User.js';
import Room from '../src/models/Room.js';
import Message from '../src/models/Message.js';

function createInMemoryRedisPubSub() {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  let nextId = 1;

  return () => {
    const nodeId = nextId++;
    return class InMemoryPubSubAdapter extends Adapter {
      constructor(nsp) {
        super(nsp);
        bus.on('broadcast', ({ sourceId, packet, opts }) => {
          if (sourceId !== nodeId) {
            super.broadcast(packet, opts);
          }
        });
        bus.on('disconnectSockets', ({ sourceId, opts, close }) => {
          if (sourceId !== nodeId) {
            super.disconnectSockets(opts, close);
          }
        });
      }

      broadcast(packet, opts) {
        super.broadcast(packet, opts);
        bus.emit('broadcast', { sourceId: nodeId, packet, opts });
      }

      disconnectSockets(opts, close) {
        super.disconnectSockets(opts, close);
        bus.emit('disconnectSockets', { sourceId: nodeId, opts, close });
      }
    };
  };
}

describe('Sub-phase 9.5: API Versioning (/api/v1), OpenAPI & Multi-Instance Adapter', () => {
  let mongoServer;
  const serversToClose = [];
  const socketsToClose = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([User.syncIndexes(), Room.syncIndexes(), Message.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Room.deleteMany({}), Message.deleteMany({})]);
  });

  afterEach(async () => {
    for (const sock of socketsToClose.splice(0)) {
      if (sock.connected) sock.disconnect();
    }
    for (const srv of serversToClose.splice(0)) {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('serves /api/v1 routes, marks legacy /api routes as Deprecated, serves /api/docs, and keeps openapi.json in sync', async () => {
    const app = createApp();

    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'V1User', password: 'StrongPassword123' });
    expect(reg.status).toBe(201);

    const v1Rooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${reg.body.token}`);
    expect(v1Rooms.status).toBe(200);
    expect(v1Rooms.headers.deprecation).toBeUndefined();

    const legacyRooms = await request(app)
      .get('/api/rooms')
      .set('Authorization', `Bearer ${reg.body.token}`);
    expect(legacyRooms.status).toBe(200);
    expect(legacyRooms.headers.deprecation).toBe('true');

    const docsRes = await request(app).get('/api/docs/');
    expect(docsRes.status).toBe(200);

    const committedOpenApi = JSON.parse(
      fs.readFileSync(path.resolve('openapi.json'), 'utf8')
    );
    expect(committedOpenApi).toEqual(generateOpenApiDocument());
  });

  it('delivers room messages and cross-node session revocation across two server instances sharing an adapter', async () => {
    const makeAdapter = createInMemoryRedisPubSub();

    const app1 = createApp();
    const srv1 = http.createServer(app1);
    serversToClose.push(srv1);
    const io1 = attachSockets(srv1, app1, { adapter: makeAdapter() });
    await new Promise((resolve) => srv1.listen(0, '127.0.0.1', resolve));

    const app2 = createApp();
    const srv2 = http.createServer(app2);
    serversToClose.push(srv2);
    attachSockets(srv2, app2, { adapter: makeAdapter() });
    await new Promise((resolve) => srv2.listen(0, '127.0.0.1', resolve));

    const url1 = `http://127.0.0.1:${srv1.address().port}`;
    const url2 = `http://127.0.0.1:${srv2.address().port}`;

    const aliceRes = await request(app1)
      .post('/api/v1/auth/register')
      .send({ username: 'NodeOneUser', password: 'StrongPassword123' });
    const bobRes = await request(app2)
      .post('/api/v1/auth/register')
      .send({ username: 'NodeTwoUser', password: 'StrongPassword123' });

    const roomRes = await request(app1)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${aliceRes.body.token}`)
      .send({ name: 'CrossNodeRoom', type: 'public' });
    const roomId = roomRes.body.room._id;

    await request(app2)
      .post(`/api/v1/rooms/${roomId}/join`)
      .set('Authorization', `Bearer ${bobRes.body.token}`);

    const sockAlice = createClient(url1, {
      transports: ['websocket'],
      auth: { token: aliceRes.body.token },
    });
    const sockBob = createClient(url2, {
      transports: ['websocket'],
      auth: { token: bobRes.body.token },
    });
    socketsToClose.push(sockAlice, sockBob);

    await Promise.all([
      new Promise((resolve) => sockAlice.once('connect', resolve)),
      new Promise((resolve) => sockBob.once('connect', resolve)),
    ]);

    // Alice on Instance 1 sends message -> Bob on Instance 2 receives it via adapter
    const bobMsgPromise = new Promise((resolve) => sockBob.once('message:new', resolve));
    const ack = await new Promise((resolve) => {
      sockAlice.emit('message:send', { roomId, text: 'Cross-node hello' }, resolve);
    });
    expect(ack.ok).toBe(true);
    const received = await bobMsgPromise;
    expect(received.text).toBe('Cross-node hello');

    // Revoking Bob's session from Instance 1 disconnects Bob's socket on Instance 2!
    const bobSessionId = JSON.parse(
      Buffer.from(bobRes.body.token.split('.')[1], 'base64url').toString('utf8')
    ).sid;
    const bobDisconnectPromise = new Promise((resolve) => sockBob.once('disconnect', resolve));
    io1.in(`session:${bobSessionId}`).disconnectSockets(true);
    await bobDisconnectPromise;
  });
});
