import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';

export const DEFAULT_WORKSPACE_NAME = 'Default';
export const DEFAULT_WORKSPACE_SLUG = 'default';

/**
 * Finds or creates the "Default" workspace safely under concurrent calls.
 */
export async function ensureDefaultWorkspace(fallbackOwnerId = null) {
  let ws = await Workspace.findOne({ slug: DEFAULT_WORKSPACE_SLUG });
  if (ws) {
    return { workspace: ws, created: false };
  }

  let ownerId = fallbackOwnerId;
  if (!ownerId) {
    const firstAdmin = await User.findOne({ globalRole: 'admin' }, { _id: 1 }).lean();
    const firstUser = firstAdmin || (await User.findOne({}, { _id: 1 }).lean());
    ownerId = firstUser?._id || new mongoose.Types.ObjectId();
  }

  try {
    ws = await Workspace.create({
      name: DEFAULT_WORKSPACE_NAME,
      slug: DEFAULT_WORKSPACE_SLUG,
      ownerId,
      plan: 'free',
    });
    return { workspace: ws, created: true };
  } catch (err) {
    if (err.code === 11000) {
      ws = await Workspace.findOne({ slug: DEFAULT_WORKSPACE_SLUG });
      if (ws) return { workspace: ws, created: false };
    }
    throw err;
  }
}

/**
 * Adds a user to the Default workspace if not already a member.
 */
export async function addUserToDefaultWorkspace(userId, globalRole = 'user') {
  const { workspace } = await ensureDefaultWorkspace(userId);
  const role = globalRole === 'admin' ? 'admin' : 'member';
  await WorkspaceMember.updateOne(
    { workspace: workspace._id, user: userId },
    { $setOnInsert: { workspace: workspace._id, user: userId, role, status: 'active' } },
    { upsert: true }
  );
  return workspace;
}

/**
 * Idempotent migration that:
 * 1. Creates the "Default" workspace if missing.
 * 2. Adds every existing user as a WorkspaceMember (global admins -> admin).
 * 3. Backfills `workspace` on every Room and Message lacking one.
 */
export async function migrateWorkspaces() {
  const { workspace, created } = await ensureDefaultWorkspace();
  const wsId = workspace._id;

  const users = await User.find({}, { _id: 1, globalRole: 1 }).lean();
  let addedMembers = 0;

  for (const u of users) {
    const res = await WorkspaceMember.updateOne(
      { workspace: wsId, user: u._id },
      {
        $setOnInsert: {
          workspace: wsId,
          user: u._id,
          role: u.globalRole === 'admin' ? 'admin' : 'member',
          status: 'active',
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount > 0) addedMembers += 1;
  }

  const roomRes = await Room.updateMany(
    { workspace: { $exists: false } },
    { $set: { workspace: wsId } },
    { bypassTenantScope: true }
  );
  const msgRes = await Message.updateMany(
    { workspace: { $exists: false } },
    { $set: { workspace: wsId } },
    { bypassTenantScope: true }
  );

  return {
    workspace,
    createdWorkspace: created,
    addedMembers,
    migratedRooms: roomRes.modifiedCount || 0,
    migratedMessages: msgRes.modifiedCount || 0,
  };
}
