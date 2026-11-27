import mongoose from 'mongoose';

const workspaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 60,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens'],
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: String,
      enum: ['free', 'pro', 'team'],
      default: 'free',
    },
    settings: {
      allowExternalProcessing: { type: Boolean, default: false },
      defaultRoomIds: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Room' }],
        default: [],
      },
      allowedInviteDomains: {
        type: [String],
        default: [],
      },
      retentionDays: {
        type: Number,
        default: null,
        min: 1,
        max: 3650,
      },
    },
  },
  {
    timestamps: true,
  }
);

workspaceSchema.index({ ownerId: 1 });

const Workspace = mongoose.model('Workspace', workspaceSchema);
export default Workspace;
