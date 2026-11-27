import mongoose from 'mongoose';

const workspaceInviteSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Store only a SHA-256 hash of the random invite token; raw token is returned once on creation.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    role: {
      type: String,
      enum: ['member', 'guest'],
      default: 'member',
      required: true,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    maxUses: {
      type: Number,
      default: null,
      min: 1,
      max: 1000,
    },
    uses: {
      type: Number,
      default: 0,
      min: 0,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

workspaceInviteSchema.index({ workspace: 1, createdAt: -1 });

const WorkspaceInvite = mongoose.model('WorkspaceInvite', workspaceInviteSchema);
export default WorkspaceInvite;
