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
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    loginLockedUntil: {
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
          createdAt: ret.createdAt,
        };
      },
    },
  }
);

const User = mongoose.model('User', userSchema);
export default User;
