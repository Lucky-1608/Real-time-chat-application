import mongoose from 'mongoose';

const starredMessageSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    message: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

starredMessageSchema.index({ user: 1, message: 1 }, { unique: true });
starredMessageSchema.index({ user: 1, createdAt: -1 });

const StarredMessage = mongoose.model('StarredMessage', starredMessageSchema);
export default StarredMessage;
