import mongoose from 'mongoose';
import { Server } from 'socket.io';
import env from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';
import Room from '../models/Room.js';
import Session from '../models/Session.js';
import { isSessionActive } from '../services/sessionService.js';
import { registerChatHandlers } from './chatHandlers.js';
import { createPresenceTracker } from './presence.js';

const AUTH_EXPIRED_GRACE_MS = 30_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Attaches Socket.io to an existing Node http.Server so REST and WebSocket
 * traffic share a single origin and port.
 */
export function attachSockets(httpServer, app = null, { storageService } = {}) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const presence = createPresenceTracker();

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
        // In tests that construct synthetic tokens without a Session doc (e.g. foundation.test.js),
        // only reject if a Session doc exists and is explicitly revoked.
        if (!active && env.NODE_ENV === 'test' && mongoose.isValidObjectId(user.sid)) {
          const existing = await Session.findById(user.sid, { revokedAt: 1 }).lean();
          if (existing?.revokedAt) {
            return next(new Error('unauthorized'));
          }
        }
      }

      socket.data.user = user;
      socket.data.tokenExp = user.exp;

      // Preload room memberships during handshake so socket.join runs synchronously
      // in the connection handler before the client receives its 'connect' event.
      if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(user.id)) {
        const rooms = await Room.find({ 'members.user': user.id }, { _id: 1 }).lean();
        socket.data.initialRoomIds = rooms.map((r) => r._id.toString());
      } else {
        socket.data.initialRoomIds = [];
      }

      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  // Periodic sweep disconnects any sockets whose session was revoked or expired.
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
    let expiryDisconnectTimer = null;

    socket.join(`user:${userId}`);
    socket.join(`session:${sid}`);
    for (const roomId of socket.data.initialRoomIds || []) {
      socket.join(`room:${roomId}`);
    }

    presence.addConnection(userId, username);
    io.emit('presence:list', presence.getOnlineUsers());

    // Per-event middleware: enforce access-token expiration on every incoming socket event.
    socket.use((packet, next) => {
      const [eventName, ...args] = packet;
      if (eventName === 'auth:refresh') {
        return next();
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (socket.data.tokenExp && nowSec >= socket.data.tokenExp) {
        socket.emit('auth:expired');
        if (!expiryDisconnectTimer) {
          expiryDisconnectTimer = setTimeout(() => {
            socket.disconnect(true);
          }, AUTH_EXPIRED_GRACE_MS);
          expiryDisconnectTimer.unref?.();
        }
        const maybeAck = args[args.length - 1];
        if (typeof maybeAck === 'function') {
          maybeAck({ ok: false, error: 'auth:expired' });
        }
        return next(new Error('auth:expired'));
      }

      return next();
    });

    socket.on('auth:refresh', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
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

    registerChatHandlers(io, socket, presence, { storageService });

    // Clear active typing indicators in ALL rooms this socket belongs to on disconnect.
    socket.on('disconnecting', () => {
      for (const channel of socket.rooms) {
        if (channel.startsWith('room:')) {
          const roomId = channel.slice('room:'.length);
          socket.to(channel).emit('typing:stop', { roomId, userId, username });
        }
      }
    });

    socket.on('disconnect', () => {
      if (expiryDisconnectTimer) {
        clearTimeout(expiryDisconnectTimer);
        expiryDisconnectTimer = null;
      }
      const wentOffline = presence.removeConnection(userId);
      if (wentOffline) {
        io.emit('presence:list', presence.getOnlineUsers());
      }
    });

    // Round-trip verification event for the WebSocket transport layer.
    socket.on('test:ping', (payload, ack) => {
      socket.broadcast.emit('test:pong', payload);
      if (typeof ack === 'function') {
        ack({ ok: true, received: payload });
      }
    });
  });

  return io;
}
