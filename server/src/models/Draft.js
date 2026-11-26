import mongoose from 'mongoose';

const draftSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    text: {
      type: String,
      maxlength: 2000,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

draftSchema.index({ user: 1, room: 1 }, { unique: true });

const Draft = mongoose.model('Draft', draftSchema);
export default Draft;
