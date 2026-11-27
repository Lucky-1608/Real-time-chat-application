import mongoose from 'mongoose';
import { tenantPlugin } from '../services/tenantScope.js';

const memberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'moderator', 'member'],
      default: 'member',
      required: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastReadAt: {
      type: Date,
      default: Date.now,
    },
    muted: {
      type: Boolean,
      default: false,
    },
    notificationLevel: {
      type: String,
      enum: ['all', 'mentions', 'muted'],
      default: 'all',
    },
  },
  { _id: false }
);

const roomSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    name: {
      type: String,
      trim: true,
      minlength: [3, 'Room name must be at least 3 characters'],
      maxlength: [30, 'Room name must be at most 30 characters'],
      required() {
        return this.type !== 'dm';
      },
    },
    // Lowercased copy for case-insensitive uniqueness on public rooms.
    nameLower: {
      type: String,
      trim: true,
      lowercase: true,
    },
    type: {
      type: String,
      enum: ['public', 'private', 'dm'],
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    members: {
      type: [memberSchema],
      default: [],
    },
    // Deterministic "minId:maxId" key used only for DM rooms so a unique sparse
    // index prevents duplicate 1-to-1 DMs even under concurrent creation races.
    dmKey: {
      type: String,
    },
    slowModeSeconds: {
      type: Number,
      default: 0,
      min: 0,
      max: 3600,
    },
    announcementMode: {
      type: Boolean,
      default: false,
    },
    maxMembers: {
      type: Number,
      default: 100,
      min: 2,
      max: 500,
    },
    allowInviteLinks: {
      type: Boolean,
      default: true,
    },
    // Room-level disappearing message TTL in seconds (0 = off, 1h, 24h, 7d).
    // Changing this affects only NEW messages created after the change.
    disappearingTtlSeconds: {
      type: Number,
      enum: [0, 3600, 86400, 604800],
      default: 0,
    },
    pinnedMessages: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }],
      default: [],
    },
    bannedUsers: {
      type: [
        {
          user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          reason: { type: String, default: '' },
          bannedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      _id: false,
    },
  },
  {
    timestamps: true,
  }
);

roomSchema.index({ workspace: 1, 'members.user': 1 });
roomSchema.index(
  { workspace: 1, dmKey: 1 },
  { unique: true, partialFilterExpression: { dmKey: { $type: 'string' } } }
);
roomSchema.index(
  { workspace: 1, nameLower: 1 },
  { unique: true, partialFilterExpression: { type: 'public' } }
);
roomSchema.plugin(tenantPlugin);

roomSchema.pre('validate', function syncDerivedFields(next) {
  if (this.type === 'dm') {
    this.name = undefined;
    this.nameLower = undefined;
  } else if (typeof this.name === 'string') {
    this.name = this.name.trim();
    this.nameLower = this.name.toLowerCase();
  }
  next();
});

export function makeDmKey(userIdA, userIdB) {
  return [userIdA.toString(), userIdB.toString()].sort().join(':');
}

const Room = mongoose.model('Room', roomSchema);
export default Room;
