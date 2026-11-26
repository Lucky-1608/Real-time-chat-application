import Room from '../models/Room.js';
import User from '../models/User.js';
import Message from '../models/Message.js';

export const GENERAL_ROOM_NAME = 'General';

/**
 * Finds or creates the seeded public "General" room safely under concurrent calls.
 */
export async function ensureGeneralRoom() {
  let general = await Room.findOne({ nameLower: 'general', type: 'public' });
  if (general) {
    return { room: general, created: false };
  }

  try {
    general = await Room.create({
      name: GENERAL_ROOM_NAME,
      type: 'public',
      members: [],
    });
    return { room: general, created: true };
  } catch (err) {
    if (err.code === 11000) {
      general = await Room.findOne({ nameLower: 'general', type: 'public' });
      if (general) return { room: general, created: false };
    }
    throw err;
  }
}

/**
 * Adds a single user to the "General" room if not already a member.
 */
export async function addUserToGeneralRoom(userId) {
  const { room } = await ensureGeneralRoom();
  const now = new Date();
  await Room.updateOne(
    { _id: room._id, 'members.user': { $ne: userId } },
    {
      $push: {
        members: {
          user: userId,
          role: 'member',
          joinedAt: now,
          lastReadAt: now,
        },
      },
    }
  );
  return room;
}

/**
 * Idempotent migration that:
 * 1. Creates the "General" public room if missing.
 * 2. Adds every existing user as a member of "General".
 * 3. Assigns room = General to any legacy message lacking a room reference.
 */
export async function migrateRooms() {
  const { room: general, created: createdGeneral } = await ensureGeneralRoom();

  const existingMemberIds = new Set(general.members.map((m) => m.user.toString()));
  const allUsers = await User.find({}, { _id: 1 }).lean();
  const now = new Date();

  const missingMembers = allUsers
    .filter((u) => !existingMemberIds.has(u._id.toString()))
    .map((u) => ({
      user: u._id,
      role: 'member',
      joinedAt: now,
      lastReadAt: now,
    }));

  let addedUsersCount = 0;
  if (missingMembers.length > 0) {
    await Room.updateOne(
      { _id: general._id },
      { $push: { members: { $each: missingMembers } } }
    );
    addedUsersCount = missingMembers.length;
  }

  const msgResult = await Message.collection.updateMany(
    { $or: [{ room: { $exists: false } }, { room: null }] },
    { $set: { room: general._id }, $unset: { roomId: '' } }
  );
  const migratedMessagesCount = msgResult.modifiedCount || 0;

  console.log(
    `[migrate:rooms] General room ${createdGeneral ? 'created' : 'already existed'} (${general._id}); added ${addedUsersCount} users; migrated ${migratedMessagesCount} messages.`
  );

  return {
    generalRoomId: general._id.toString(),
    createdGeneral,
    addedUsersCount,
    migratedMessagesCount,
  };
}
