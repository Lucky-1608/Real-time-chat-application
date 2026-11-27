import crypto from 'node:crypto';
import User from '../models/User.js';
import Room, { makeDmKey } from '../models/Room.js';
import Message from '../models/Message.js';
import Workspace from '../models/Workspace.js';

export const WELCOME_BOT_USERNAME = 'Welcome Bot';
export const DEMO_ROOM_NAME = 'demo-playground';

/**
 * Ensures the system "Welcome Bot" user exists. Marked `isSystem: true` so
 * password login is permanently blocked.
 */
export async function ensureWelcomeBot() {
  let bot = await User.findOne({ usernameLower: WELCOME_BOT_USERNAME.toLowerCase() });
  if (bot) return bot;

  try {
    bot = await User.create({
      username: WELCOME_BOT_USERNAME,
      usernameLower: WELCOME_BOT_USERNAME.toLowerCase(),
      passwordHash: `!system-no-login-${crypto.randomBytes(32).toString('hex')}`,
      isSystem: true,
    });
    return bot;
  } catch (err) {
    if (err.code === 11000) {
      return User.findOne({ usernameLower: WELCOME_BOT_USERNAME.toLowerCase() });
    }
    throw err;
  }
}

/**
 * Seeds #General, #random, and a Welcome Bot DM on workspace creation.
 */
export async function seedWorkspaceOnboarding(workspaceId, ownerId) {
  let general = await Room.findOne({
    workspace: workspaceId,
    type: 'public',
    nameLower: 'general',
  });
  if (!general) {
    general = await Room.create({
      workspace: workspaceId,
      name: 'General',
      nameLower: 'general',
      type: 'public',
      createdBy: ownerId,
      members: [{ user: ownerId, role: 'owner' }],
    });
  }

  let random = await Room.findOne({
    workspace: workspaceId,
    type: 'public',
    nameLower: 'random',
  });
  if (!random) {
    random = await Room.create({
      workspace: workspaceId,
      name: 'random',
      nameLower: 'random',
      type: 'public',
      createdBy: ownerId,
      members: [{ user: ownerId, role: 'owner' }],
    });
  }

  await Workspace.updateOne(
    { _id: workspaceId },
    { $set: { 'settings.defaultRoomIds': [general._id, random._id] } }
  );

  const bot = await ensureWelcomeBot();
  if (bot && bot._id.toString() !== ownerId.toString()) {
    const dmKey = makeDmKey(ownerId, bot._id);
    let dm = await Room.findOne({ workspace: workspaceId, type: 'dm', dmKey });
    if (!dm) {
      dm = await Room.create({
        workspace: workspaceId,
        type: 'dm',
        dmKey,
        createdBy: bot._id,
        members: [
          { user: ownerId, role: 'member' },
          { user: bot._id, role: 'member' },
        ],
      });
      await Message.create({
        workspace: workspaceId,
        room: dm._id,
        sender: bot._id,
        senderName: bot.username,
        text: 'Welcome to your new workspace! Use #General for team updates, #random for watercooler chat, or click "Help / Tour" anytime for a quick walkthrough.',
      });
    }
  }

  return { general, random };
}

/**
 * Adds a #demo-playground room with sample messages for product evaluation.
 */
export async function addDemoContent(workspaceId, userId) {
  let room = await Room.findOne({
    workspace: workspaceId,
    type: 'public',
    nameLower: DEMO_ROOM_NAME,
  });

  if (!room) {
    room = await Room.create({
      workspace: workspaceId,
      name: DEMO_ROOM_NAME,
      nameLower: DEMO_ROOM_NAME,
      type: 'public',
      createdBy: userId,
      members: [{ user: userId, role: 'owner' }],
    });
  } else if (!room.members.some((m) => m.user.toString() === userId.toString())) {
    await Room.updateOne(
      { _id: room._id, workspace: workspaceId },
      { $push: { members: { user: userId, role: 'member' } } }
    );
  }

  const existingCount = await Message.countDocuments({ workspace: workspaceId, room: room._id });
  if (existingCount === 0) {
    const bot = await ensureWelcomeBot();
    const samples = [
      'Welcome to #demo-playground! Here you can test markdown, **bold text**, `inline code`, and reactions.',
      'Tip: Hover over any message to edit, react with an emoji, pin, or star it.',
      'Tip: Try the "Catch me up" button in the header to summarize unread activity.',
      'When you are done evaluating, click "Remove demo content" to clean up this room in one click.',
    ];
    for (const text of samples) {
      await Message.create({
        workspace: workspaceId,
        room: room._id,
        sender: bot._id,
        senderName: bot.username,
        text,
      });
    }
  }

  const messageCount = await Message.countDocuments({ workspace: workspaceId, room: room._id });
  return { room, messageCount };
}

/**
 * Removes the #demo-playground room and all of its messages in one click.
 */
export async function removeDemoContent(workspaceId) {
  const room = await Room.findOne({
    workspace: workspaceId,
    type: 'public',
    nameLower: DEMO_ROOM_NAME,
  });
  if (!room) {
    return { removed: false };
  }
  await Message.deleteMany({ workspace: workspaceId, room: room._id });
  await Room.deleteOne({ _id: room._id, workspace: workspaceId });
  return { removed: true };
}
