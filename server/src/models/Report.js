import mongoose from 'mongoose';

export const REPORT_REASONS = ['spam', 'harassment', 'hate_speech', 'inappropriate', 'other'];
export const MODERATION_ACTIONS = ['dismiss', 'delete_message', 'warn', 'kick', 'ban', 'suspend'];

const reportSchema = new mongoose.Schema(
  {
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    targetType: {
      type: String,
      enum: ['message', 'user'],
      required: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    targetUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    roomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    reason: {
      type: String,
      enum: REPORT_REASONS,
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    // Immutable snapshot of the reported message text at report creation time so
    // moderators still have evidence even if the author edits or deletes it later.
    messageSnapshot: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['open', 'resolved', 'dismissed'],
      default: 'open',
    },
    resolutionAction: {
      type: String,
      enum: [...MODERATION_ACTIONS, null],
      default: null,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

reportSchema.index({ roomId: 1, status: 1, createdAt: -1 });
reportSchema.index({ status: 1, createdAt: -1 });

const Report = mongoose.model('Report', reportSchema);
export default Report;
