import mongoose from 'mongoose';

const webhookDeliverySchema = new mongoose.Schema(
  {
    webhook: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IncomingWebhook',
      required: true,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    status: {
      type: String,
      enum: ['delivered', 'deduplicated', 'rejected'],
      required: true,
    },
    httpStatus: {
      type: Number,
      required: true,
    },
    eventType: {
      type: String,
      default: 'generic',
    },
    error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

webhookDeliverySchema.index({ webhook: 1, createdAt: -1 });

const WebhookDelivery = mongoose.model('WebhookDelivery', webhookDeliverySchema);
export default WebhookDelivery;
