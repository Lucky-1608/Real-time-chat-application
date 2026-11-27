import crypto from 'node:crypto';
import mongoose from 'mongoose';

const scheduledMessageSchema = new mongoose.Schema(
  {
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    senderName: {
      type: String,
      required: true,
    },
    isBot: {
      type: Boolean,
      default: false,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    sendAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'sent', 'cancelled', 'failed'],
      default: 'pending',
    },
    leaseUntil: {
      type: Date,
      default: null,
    },
    failureReason: {
      type: String,
      default: null,
    },
    // Unique idempotency key copied onto Message.scheduledKey so at-least-once
    // retries after a crashed worker lease can never insert duplicate messages.
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomUUID(),
    },
    sentMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

scheduledMessageSchema.index({ status: 1, sendAt: 1, leaseUntil: 1 });
scheduledMessageSchema.index({ sender: 1, status: 1 });

const ScheduledMessage = mongoose.model('ScheduledMessage', scheduledMessageSchema);
export default ScheduledMessage;
