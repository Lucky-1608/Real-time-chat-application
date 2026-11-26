import mongoose from 'mongoose';
import { Server } from 'socket.io';
import env from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';
import Room from '../models/Room.js';
import { registerChatHandlers } from './chatHandlers.js';
import { createPresenceTracker } from './presence.js';

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
      socket.data.user = user;

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

  io.on('connection', (socket) => {
    const { id: userId, username } = socket.data.user;

    socket.join(`user:${userId}`);
    for (const roomId of socket.data.initialRoomIds || []) {
      socket.join(`room:${roomId}`);
    }

    presence.addConnection(userId, username);
    io.emit('presence:list', presence.getOnlineUsers());

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
