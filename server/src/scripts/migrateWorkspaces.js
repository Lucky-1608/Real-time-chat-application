import 'dotenv/config';
import mongoose from 'mongoose';
import env from '../config/env.js';
import { migrateWorkspaces } from '../services/workspaceMigration.js';

async function run() {
  await mongoose.connect(env.MONGO_URI);
  try {
    const result = await migrateWorkspaces();
    console.log(
      `[migrate:workspaces] Default workspace (${result.workspace._id}); created=${result.createdWorkspace}; addedMembers=${result.addedMembers}; migratedRooms=${result.migratedRooms}; migratedMessages=${result.migratedMessages}`
    );
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[migrate:workspaces] Failed:', err);
  process.exit(1);
});
