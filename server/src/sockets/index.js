import { Server } from 'socket.io';
import env from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';
import { registerChatHandlers } from './chatHandlers.js';

/**
 * Attaches Socket.io to an existing Node http.Server so REST and WebSocket
 * traffic share a single origin and port.
 */
export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      socket.data.user = verifyToken(token);
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Join the default global room; future private rooms/DMs can join additional room IDs.
    socket.join('global');

    registerChatHandlers(io, socket);

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
