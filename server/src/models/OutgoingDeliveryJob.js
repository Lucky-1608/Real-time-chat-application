import crypto from 'node:crypto';
import mongoose from 'mongoose';

const outgoingDeliveryJobSchema = new mongoose.Schema(
  {
    webhook: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OutgoingWebhook',
      required: true,
    },
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
    event: {
      type: String,
      required: true,
    },
    eventId: {
      type: String,
      required: true,
    },
    deliveryId: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomUUID(),
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'delivered', 'dead_letter'],
      default: 'pending',
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxAttempts: {
      type: Number,
      default: 6,
    },
    nextAttemptAt: {
      type: Date,
      default: Date.now,
    },
    leaseUntil: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

outgoingDeliveryJobSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });

const OutgoingDeliveryJob = mongoose.model('OutgoingDeliveryJob', outgoingDeliveryJobSchema);
export default OutgoingDeliveryJob;
