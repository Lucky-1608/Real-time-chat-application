import http from 'node:http';
import mongoose from 'mongoose';
import env from './config/env.js';
import app from './app.js';
import { attachSockets } from './sockets/index.js';
import { defaultStorageService } from './services/storage.js';
import { createClamdScanner, createScanWorker } from './services/scanWorker.js';

async function startServer() {
  await mongoose.connect(env.MONGO_URI);
  console.log('[db] Connected to MongoDB');

  // Share one HTTP server between Express and Socket.io on a single port.
  const httpServer = http.createServer(app);
  const io = attachSockets(httpServer, app);

  let scanWorker = null;
  if (defaultStorageService.isConfigured() && env.CLAMD_HOST) {
    const scanner = await createClamdScanner({ host: env.CLAMD_HOST, port: env.CLAMD_PORT });
    scanWorker = createScanWorker({
      storageService: defaultStorageService,
      scanner,
      io,
      pollIntervalMs: env.SCAN_POLL_INTERVAL_MS,
    });
    scanWorker.start();
    console.log(`[scanWorker] Polling quarantine uploads via clamd (${env.CLAMD_HOST}:${env.CLAMD_PORT})`);
  }

  httpServer.listen(env.PORT, () => {
    console.log(`[server] Listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down gracefully...`);
    scanWorker?.stop();
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
