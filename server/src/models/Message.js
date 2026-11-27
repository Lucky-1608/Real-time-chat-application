import mongoose from 'mongoose';
import { tenantPlugin } from '../services/tenantScope.js';

export const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

const reactionSchema = new mongoose.Schema(
  {
    emoji: {
      type: String,
      enum: ALLOWED_REACTIONS,
      required: true,
    },
    users: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { _id: false }
);

const attachmentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 255 },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    scanStatus: {
      type: String,
      enum: ['pending', 'clean', 'rejected'],
      default: 'pending',
    },
    scanReason: { type: String, default: null },
    scanClaimedAt: { type: Date, default: null },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Denormalized to avoid populating User on every history page load.
    senderName: {
      type: String,
      required: true,
    },
    isBot: {
      type: Boolean,
      default: false,
    },
    // Trade-off: originalText is intentionally not stored; soft-deleted messages
    // clear text to "" so deleted content is never retained or leaked to clients.
    text: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000,
    },
    kind: {
      type: String,
      enum: ['text', 'poll'],
      default: 'text',
    },
    poll: {
      type: {
        question: { type: String, required: true, trim: true, maxlength: 200 },
        options: [
          {
            id: { type: String, required: true },
            text: { type: String, required: true, trim: true, maxlength: 80 },
            votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
            _id: false,
          },
        ],
        multiple: { type: Boolean, default: false },
        anonymous: { type: Boolean, default: false },
        closesAt: { type: Date, default: null },
        closedAt: { type: Date, default: null },
      },
      default: null,
      _id: false,
    },
    mentions: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    reactions: {
      type: [reactionSchema],
      default: [],
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    editedAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    scheduledKey: {
      type: String,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ workspace: 1, room: 1, createdAt: -1 });
messageSchema.index({ room: 1, createdAt: -1 });
messageSchema.index({ room: 1, updatedAt: -1 });
messageSchema.index({ 'attachments.scanStatus': 1, 'attachments.scanClaimedAt': 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
messageSchema.index({ scheduledKey: 1 }, { unique: true, sparse: true });
messageSchema.plugin(tenantPlugin);

export function serializeReactions(reactions = []) {
  return reactions
    .filter((r) => Array.isArray(r.users) && r.users.length > 0)
    .map((r) => ({
      emoji: r.emoji,
      users: r.users.map((id) => id.toString()),
    }));
}

export function serializePoll(poll) {
  if (!poll) return null;
  const toIso = (d) => (d instanceof Date ? d.toISOString() : d || null);
  const isClosed = Boolean(
    poll.closedAt || (poll.closesAt && new Date(poll.closesAt).getTime() <= Date.now())
  );
  return {
    question: poll.question,
    multiple: Boolean(poll.multiple),
    anonymous: Boolean(poll.anonymous),
    closesAt: toIso(poll.closesAt),
    closedAt: toIso(poll.closedAt),
    isClosed,
    options: (poll.options || []).map((o) => ({
      id: o.id,
      text: o.text,
      count: Array.isArray(o.votes) ? o.votes.length : 0,
      ...(poll.anonymous ? {} : { votes: (o.votes || []).map((id) => id.toString()) }),
    })),
  };
}

export function serializeMessage(doc) {
  const isDeleted = Boolean(doc.deletedAt);
  const toIso = (d) => (d instanceof Date ? d.toISOString() : d || null);

  return {
    _id: doc._id.toString(),
    workspace: doc.workspace ? doc.workspace.toString() : null,
    room: doc.room.toString(),
    sender: doc.sender.toString(),
    senderName: doc.senderName,
    isBot: Boolean(doc.isBot),
    kind: doc.kind || 'text',
    text: isDeleted ? '' : doc.text,
    poll: isDeleted ? null : serializePoll(doc.poll),
    mentions: isDeleted ? [] : (doc.mentions || []).map((id) => id.toString()),
    readBy: (doc.readBy || []).map((id) => id.toString()),
    reactions: isDeleted ? [] : serializeReactions(doc.reactions),
    attachments: isDeleted
      ? []
      : (doc.attachments || []).map((a) => ({
          key: a.key,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          scanStatus: a.scanStatus || 'pending',
          scanReason: a.scanReason || null,
        })),
    editedAt: isDeleted ? null : toIso(doc.editedAt),
    deletedAt: toIso(doc.deletedAt),
    expiresAt: toIso(doc.expiresAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

const Message = mongoose.model('Message', messageSchema);
export default Message;
