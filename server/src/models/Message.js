import mongoose from 'mongoose';

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

const messageSchema = new mongoose.Schema(
  {
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
    // Trade-off: originalText is intentionally not stored; soft-deleted messages
    // clear text to "" so deleted content is never retained or leaked to clients.
    text: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000,
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
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ room: 1, createdAt: -1 });
messageSchema.index({ room: 1, updatedAt: -1 });

export function serializeReactions(reactions = []) {
  return reactions
    .filter((r) => Array.isArray(r.users) && r.users.length > 0)
    .map((r) => ({
      emoji: r.emoji,
      users: r.users.map((id) => id.toString()),
    }));
}

export function serializeMessage(doc) {
  const isDeleted = Boolean(doc.deletedAt);
  const toIso = (d) => (d instanceof Date ? d.toISOString() : d || null);

  return {
    _id: doc._id.toString(),
    room: doc.room.toString(),
    sender: doc.sender.toString(),
    senderName: doc.senderName,
    text: isDeleted ? '' : doc.text,
    readBy: (doc.readBy || []).map((id) => id.toString()),
    reactions: isDeleted ? [] : serializeReactions(doc.reactions),
    editedAt: isDeleted ? null : toIso(doc.editedAt),
    deletedAt: toIso(doc.deletedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

const Message = mongoose.model('Message', messageSchema);
export default Message;
