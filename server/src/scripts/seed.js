import 'dotenv/config';
import mongoose from 'mongoose';
import env from '../config/env.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import { defaultPasswordService } from '../services/passwordService.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';

async function seed() {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run demo seed script in production!');
  }

  await mongoose.connect(env.MONGO_URI);
  try {
    const { room: general } = await ensureGeneralRoom();
    const demoUsers = [
      { username: 'alice', password: 'DemoPassword123!', globalRole: 'user' },
      { username: 'bob', password: 'DemoPassword123!', globalRole: 'user' },
      { username: 'admin', password: 'AdminPassword123!', globalRole: 'admin' },
    ];

    const createdIds = [];
    for (const u of demoUsers) {
      let doc = await User.findOne({ usernameLower: u.username.toLowerCase() });
      if (!doc) {
        const passwordHash = await defaultPasswordService.hashPassword(u.password);
        doc = await User.create({
          username: u.username,
          usernameLower: u.username.toLowerCase(),
          passwordHash,
          globalRole: u.globalRole,
        });
      }
      createdIds.push(doc._id);
      await Room.updateOne(
        { _id: general._id, 'members.user': { $ne: doc._id } },
        { $push: { members: { user: doc._id, role: 'member' } } }
      );
    }

    const existingLounge = await Room.findOne({ nameLower: 'lounge', type: 'public' });
    if (!existingLounge) {
      await Room.create({
        name: 'Lounge',
        type: 'public',
        createdBy: createdIds[0],
        members: createdIds.map((id, idx) => ({
          user: id,
          role: idx === 0 ? 'owner' : 'member',
        })),
      });
    }

    console.log('[seed] Demo users (alice, bob, admin) and rooms seeded successfully.');
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
