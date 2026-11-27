import mongoose from 'mongoose';

const webhookIdempotencySchema = new mongoose.Schema({
  webhook: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IncomingWebhook',
    required: true,
  },
  key: {
    type: String,
    required: true,
    maxlength: 128,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400, // 24 hours TTL
  },
});

webhookIdempotencySchema.index({ webhook: 1, key: 1 }, { unique: true });

const WebhookIdempotency = mongoose.model('WebhookIdempotency', webhookIdempotencySchema);
export default WebhookIdempotency;
