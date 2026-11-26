import mongoose from 'mongoose';

const inviteLinkSchema = new mongoose.Schema(
  {
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
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

inviteLinkSchema.index({ room: 1, createdAt: -1 });

const InviteLink = mongoose.model('InviteLink', inviteLinkSchema);
export default InviteLink;
