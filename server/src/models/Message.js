import mongoose from 'mongoose';

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

messageSchema.index({ room: 1, createdAt: -1 });

export function serializeMessage(doc) {
  return {
    _id: doc._id.toString(),
    room: doc.room.toString(),
    sender: doc.sender.toString(),
    senderName: doc.senderName,
    text: doc.text,
    readBy: (doc.readBy || []).map((id) => id.toString()),
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  };
}

const Message = mongoose.model('Message', messageSchema);
export default Message;
