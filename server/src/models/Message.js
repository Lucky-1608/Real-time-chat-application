import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    // Defaulting to 'global' allows private rooms or DMs to be added later
    // without migrating existing documents or rewriting queries.
    roomId: {
      type: String,
      default: 'global',
      required: true,
      index: true,
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
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ createdAt: -1 });
messageSchema.index({ roomId: 1, createdAt: -1 });

export function serializeMessage(doc) {
  return {
    _id: doc._id.toString(),
    roomId: doc.roomId,
    sender: doc.sender.toString(),
    senderName: doc.senderName,
    text: doc.text,
    readBy: (doc.readBy || []).map((id) => id.toString()),
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  };
}

const Message = mongoose.model('Message', messageSchema);
export default Message;
