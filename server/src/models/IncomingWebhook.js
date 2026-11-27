import mongoose from 'mongoose';

const incomingWebhookSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 40,
    },
    formatter: {
      type: String,
      enum: ['generic', 'github'],
      default: 'generic',
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
    },
    // Encrypted GitHub HMAC signing secret (only set when formatter === 'github').
    signingSecretEnc: {
      type: String,
      default: null,
    },
    // Linked system User (isSystem: true, isBot: true) used as Message.sender.
    botUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastUsedAt: {
      type: Date,
      default: null,
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

incomingWebhookSchema.index({ workspace: 1, room: 1, createdAt: -1 });

const IncomingWebhook = mongoose.model('IncomingWebhook', incomingWebhookSchema);
export default IncomingWebhook;
