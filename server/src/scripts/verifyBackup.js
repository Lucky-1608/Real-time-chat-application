import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';
import Session from '../models/Session.js';
import AuditEvent from '../models/AuditEvent.js';

async function verifyBackup() {
  const uri = process.env.BACKUP_VERIFY_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI or BACKUP_VERIFY_URI is required');
  }

  await mongoose.connect(uri);
  try {
    const [users, rooms, messages, sessions, audits] = await Promise.all([
      User.countDocuments({}),
      Room.countDocuments({}, { bypassTenantScope: true }),
      Message.countDocuments({}, { bypassTenantScope: true }),
      Session.countDocuments({}),
      AuditEvent.countDocuments({}),
    ]);

    const sampleUser = await User.findOne({}, { username: 1, createdAt: 1 }).lean();
    const userIndexes = await User.collection.indexes();
    const msgIndexes = await Message.collection.indexes();

    console.log('[backup-verify] Counts:', { users, rooms, messages, sessions, audits });
    console.log('[backup-verify] Sample user:', sampleUser);
    console.log('[backup-verify] User indexes:', userIndexes.map((i) => i.name));
    console.log('[backup-verify] Message indexes:', msgIndexes.map((i) => i.name));

    if (rooms === 0 || !userIndexes.some((i) => i.key?.usernameLower)) {
      throw new Error('Backup verification failed: missing expected data or indexes');
    }
    console.log('[backup-verify] Restore verification PASSED');
  } finally {
    await mongoose.disconnect();
  }
}

verifyBackup().catch((err) => {
  console.error('[backup-verify] FAILED:', err);
  process.exit(1);
});
