import http from 'node:http';
import mongoose from 'mongoose';
import env from './config/env.js';
import app from './app.js';
import { attachSockets } from './sockets/index.js';

async function startServer() {
  await mongoose.connect(env.MONGO_URI);
  console.log('[db] Connected to MongoDB');

  // Share one HTTP server between Express and Socket.io on a single port.
  const httpServer = http.createServer(app);
  attachSockets(httpServer, app);

  httpServer.listen(env.PORT, () => {
    console.log(`[server] Listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down gracefully...`);
    httpServer.close(async () => {
      await mongoose.connection.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
