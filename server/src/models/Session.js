import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Groups rotated refresh tokens so reuse detection can revoke the entire chain.
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    currentTokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    previousTokenHash: {
      type: String,
      default: null,
      index: true,
    },
    rotatedAt: {
      type: Date,
      default: null,
    },
    userAgent: {
      type: String,
      default: '',
    },
    ip: {
      type: String,
      default: '',
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokeReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// MongoDB automatically deletes expired sessions after expiresAt.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Session = mongoose.model('Session', sessionSchema);
export default Session;
