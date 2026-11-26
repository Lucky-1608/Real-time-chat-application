import mongoose from 'mongoose';
import env from '../config/env.js';
import { migrateRooms } from '../services/roomMigration.js';

async function run() {
  await mongoose.connect(env.MONGO_URI);
  try {
    await migrateRooms();
  } finally {
    await mongoose.connection.close();
  }
}

run().catch((err) => {
  console.error('[migrate:rooms] Migration failed:', err);
  process.exit(1);
});
