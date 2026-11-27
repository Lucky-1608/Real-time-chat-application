import mongoose from 'mongoose';
import { Server } from 'socket.io';
import env from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';
import Room from '../models/Room.js';
import Session from '../models/Session.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import { ensureDefaultWorkspace } from '../services/workspaceMigration.js';
import { isSessionActive } from '../services/sessionService.js';
import { activeSocketsGauge, socketEventsCounter } from '../services/metricsService.js';
import { registerChatHandlers } from './chatHandlers.js';
import { createPresenceTracker } from './presence.js';

const AUTH_EXPIRED_GRACE_MS = 30_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;
const MAX_HTTP_BUFFER_BYTES = 100 * 1024; // ~100 KB
const MAX_SOCKETS_PER_USER = 10;
const MAX_SOCKETS_PER_IP = 30;
const ALL_EVENTS_WINDOW_MS = 10_000;
const MAX_ALL_EVENTS_PER_WINDOW = 60;
const MAX_UNKNOWN_EVENT_STRIKES = 3;

const ALLOWED_SOCKET_EVENTS = new Set([
  'message:send',
  'message:edit',
  'message:delete',
  'message:read',
  'reaction:toggle',
  'typing:start',
  'typing:stop',
  'room:subscribe',
  'auth:refresh',
  'test:ping',
]);

/**
 * Attaches Socket.io to an existing Node http.Server so REST and WebSocket
 * traffic share a single origin and port.
 */
export function attachSockets(httpServer, app = null, { storageService, floodControl, adapter } = {}) {
  const io = new Server(httpServer, {
    ...(adapter ? { adapter } : {}),
    maxHttpBufferSize: MAX_HTTP_BUFFER_BYTES,
    cors: {
      origin: env.CLIENT_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (origin && origin !== env.CLIENT_URL) {
        return callback('Origin not allowed', false);
      }
      if (!origin && env.NODE_ENV === 'production') {
        return callback('Origin required', false);
      }
      return callback(null, true);
    },
  });

  const presence = createPresenceTracker();
  const socketsByUser = new Map();
  const socketsByIp = new Map();

  if (app) {
    app.locals.io = io;
    app.locals.presence = presence;
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      const user = verifyToken(token);
      if (mongoose.connection.readyState === 1) {
        const active = await isSessionActive(user.sid);
        if (!active && env.NODE_ENV !== 'test') {
          return next(new Error('unauthorized'));
        }
        if (!active && env.NODE_ENV === 'test' && mongoose.isValidObjectId(user.sid)) {
          const existing = await Session.findById(user.sid, { revokedAt: 1 }).lean();
          if (existing?.revokedAt) {
            return next(new Error('unauthorized'));
          }
        }
      }

      const userCount = socketsByUser.get(user.id) || 0;
      if (userCount >= MAX_SOCKETS_PER_USER) {
        return next(new Error('Too many open connections for this user'));
      }

      const ip = socket.handshake.address || 'unknown';
      const ipCount = socketsByIp.get(ip) || 0;
      if (ipCount >= MAX_SOCKETS_PER_IP) {
        return next(new Error('Too many connections from this IP'));
      }

      socket.data.user = user;
      socket.data.tokenExp = user.exp;
      socket.data.clientIp = ip;

      if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(user.id)) {
        let memberships = await WorkspaceMember.find(
          { user: user.id, status: 'active' },
          { workspace: 1 }
        ).lean();
        if (memberships.length === 0) {
          const { workspace } = await ensureDefaultWorkspace(user.id);
          await WorkspaceMember.updateOne(
            { workspace: workspace._id, user: user.id },
            { $setOnInsert: { workspace: workspace._id, user: user.id, role: 'member', status: 'active' } },
            { upsert: true }
          );
          memberships = [{ workspace: workspace._id }];
        }
        socket.data.workspaceIds = memberships.map((m) => m.workspace.toString());
        const requestedWs = socket.handshake.auth?.workspaceId;
        socket.data.activeWorkspaceId =
          requestedWs && socket.data.workspaceIds.includes(String(requestedWs))
            ? String(requestedWs)
            : socket.data.workspaceIds[0];

        const rooms = await Room.find(
          { workspace: { $in: memberships.map((m) => m.workspace) }, 'members.user': user.id },
          { _id: 1 }
        ).lean();
        socket.data.initialRoomIds = rooms.map((r) => r._id.toString());
      } else {
        socket.data.workspaceIds = [];
        socket.data.initialRoomIds = [];
      }

      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  const sweepTimer = setInterval(async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      const sockets = await io.fetchSockets();
      const sids = [
        ...new Set(
          sockets
            .map((s) => s.data.user?.sid)
            .filter((sid) => sid && mongoose.isValidObjectId(sid))
        ),
      ];
      if (sids.length === 0) return;

      const revokedOrExpired = await Session.find(
        {
          _id: { $in: sids },
          $or: [{ revokedAt: { $ne: null } }, { expiresAt: { $lte: new Date() } }],
        },
        { _id: 1 }
      ).lean();

      for (const s of revokedOrExpired) {
        io.in(`session:${s._id.toString()}`).disconnectSockets(true);
      }
    } catch {
      // Non-fatal sweep error
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  io.on('close', () => clearInterval(sweepTimer));

  io.on('connection', (socket) => {
    const { id: userId, username, sid } = socket.data.user;
    const clientIp = socket.data.clientIp || 'unknown';
    let expiryDisconnectTimer = null;
    let unknownEventStrikes = 0;
    const allEventTimestamps = [];

    socketsByUser.set(userId, (socketsByUser.get(userId) || 0) + 1);
    socketsByIp.set(clientIp, (socketsByIp.get(clientIp) || 0) + 1);

    socket.join(`user:${userId}`);
    socket.join(`session:${sid}`);
    for (const roomId of socket.data.initialRoomIds || []) {
      socket.join(`room:${roomId}`);
    }

    presence.addConnection(userId, username);
    activeSocketsGauge.inc();
    io.emit('presence:list', presence.getOnlineUsers());

    // Per-event middleware: enforce event allowlist, global rate limit, and token expiration.
    socket.use((packet, next) => {
      const [eventName, ...args] = packet;
      socketEventsCounter.inc({ event: String(eventName || 'unknown') });
      const maybeAck = args[args.length - 1];
      const rejectWithAck = (msg) => {
        if (typeof maybeAck === 'function') {
          maybeAck({ ok: false, error: msg });
        }
        return next(new Error(msg));
      };

      if (!ALLOWED_SOCKET_EVENTS.has(eventName)) {
        unknownEventStrikes += 1;
        if (unknownEventStrikes >= MAX_UNKNOWN_EVENT_STRIKES) {
          socket.disconnect(true);
        }
        return rejectWithAck('Unknown socket event');
      }

      const nowMs = Date.now();
      while (
        allEventTimestamps.length > 0 &&
        nowMs - allEventTimestamps[0] >= ALL_EVENTS_WINDOW_MS
      ) {
        allEventTimestamps.shift();
      }
      if (allEventTimestamps.length >= MAX_ALL_EVENTS_PER_WINDOW) {
        return rejectWithAck('Socket event rate limit exceeded');
      }
      allEventTimestamps.push(nowMs);

      if (eventName === 'auth:refresh') {
        return next();
      }

      const nowSec = Math.floor(nowMs / 1000);
      if (socket.data.tokenExp && nowSec >= socket.data.tokenExp) {
        socket.emit('auth:expired');
        if (!expiryDisconnectTimer) {
          expiryDisconnectTimer = setTimeout(() => {
            socket.disconnect(true);
          }, AUTH_EXPIRED_GRACE_MS);
          expiryDisconnectTimer.unref?.();
        }
        return rejectWithAck('auth:expired');
      }

      return next();
    });

    socket.on('auth:refresh', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => { };
      try {
        const refreshed = verifyToken(payload?.token);
        if (refreshed.sid !== sid || refreshed.id !== userId) {
          return respond({ ok: false, error: 'Session mismatch' });
        }
        if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(sid)) {
          const active = await isSessionActive(sid);
          if (!active) {
            socket.disconnect(true);
            return respond({ ok: false, error: 'Session revoked' });
          }
        }
        socket.data.tokenExp = refreshed.exp;
        if (expiryDisconnectTimer) {
          clearTimeout(expiryDisconnectTimer);
          expiryDisconnectTimer = null;
        }
        return respond({ ok: true });
      } catch {
        return respond({ ok: false, error: 'Invalid token' });
      }
    });

    registerChatHandlers(io, socket, presence, { storageService, floodControl });

    socket.on('disconnecting', () => {
      for (const channel of socket.rooms) {
        if (channel.startsWith('room:')) {
          const roomId = channel.slice('room:'.length);
          socket.to(channel).emit('typing:stop', { roomId, userId, username });
        }
      }
    });

    socket.on('disconnect', () => {
      activeSocketsGauge.dec();
      if (expiryDisconnectTimer) {
        clearTimeout(expiryDisconnectTimer);
        expiryDisconnectTimer = null;
      }

      const uCount = (socketsByUser.get(userId) || 1) - 1;
      if (uCount <= 0) socketsByUser.delete(userId);
      else socketsByUser.set(userId, uCount);

      const iCount = (socketsByIp.get(clientIp) || 1) - 1;
      if (iCount <= 0) socketsByIp.delete(clientIp);
      else socketsByIp.set(clientIp, iCount);

      const wentOffline = presence.removeConnection(userId);
      if (wentOffline) {
        io.emit('presence:list', presence.getOnlineUsers());
      }
    });

    socket.on('test:ping', (payload, ack) => {
      socket.broadcast.emit('test:pong', payload);
      if (typeof ack === 'function') {
        ack({ ok: true, received: payload });
      }
    });
  });

  return io;
}
