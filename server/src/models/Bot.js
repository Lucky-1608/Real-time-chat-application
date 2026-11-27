import mongoose from 'mongoose';

const botSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    // Linked system User (isSystem: true, isBot: true) so Message.sender and Room.members work uniformly.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 32,
    },
    username: {
      type: String,
      required: true,
      trim: true,
    },
    avatar: {
      type: String,
      default: null,
      maxlength: 500,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    scopes: {
      type: [String],
      enum: ['messages:write', 'messages:read', 'commands:register'],
      default: ['messages:write'],
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    disabledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

botSchema.index({ workspace: 1, name: 1 });

const Bot = mongoose.model('Bot', botSchema);
export default Bot;
