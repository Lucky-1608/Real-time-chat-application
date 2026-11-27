import mongoose from 'mongoose';

export const OUTGOING_WEBHOOK_EVENTS = [
  'message.created',
  'message.updated',
  'message.deleted',
  'member.joined',
  'member.left',
  'reaction.added',
  'poll.closed',
  'command.invoked',
];

const outgoingWebhookSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      default: null,
    },
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    events: {
      type: [String],
      enum: OUTGOING_WEBHOOK_EVENTS,
      required: true,
    },
    signingSecretEnc: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    failureCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    disabledReason: {
      type: String,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

outgoingWebhookSchema.index({ workspace: 1, enabled: 1, room: 1 });

const OutgoingWebhook = mongoose.model('OutgoingWebhook', outgoingWebhookSchema);
export default OutgoingWebhook;
