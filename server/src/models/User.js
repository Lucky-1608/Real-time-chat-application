import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
    },
    // Store a lowercased copy so uniqueness is case-insensitive without
    // relying on MongoDB collation settings on every query.
    usernameLower: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    globalRole: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    loginLockedUntil: {
      type: Date,
      default: null,
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecretEnc: {
      type: String,
      default: null,
    },
    twoFactorPendingSecretEnc: {
      type: String,
      default: null,
    },
    twoFactorLastStep: {
      type: Number,
      default: null,
    },
    recoveryCodeHashes: {
      type: [
        {
          hash: { type: String, required: true },
          usedAt: { type: Date, default: null },
        },
      ],
      default: [],
      _id: false,
    },
    blockedUsers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    mutedUsers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    suspendedAt: {
      type: Date,
      default: null,
    },
    suspensionReason: {
      type: String,
      default: null,
    },
    lastExportAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        return {
          id: ret._id.toString(),
          username: ret.username,
          globalRole: ret.globalRole || 'user',
          twoFactorEnabled: Boolean(ret.twoFactorEnabled),
          createdAt: ret.createdAt,
        };
      },
    },
  }
);

const User = mongoose.model('User', userSchema);
export default User;
