import mongoose from 'mongoose';

const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    endpoint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    // Encrypted JSON { p256dh, auth } using Phase 8 cryptoService.
    keysEnc: {
      type: String,
      required: true,
    },
    userAgent: {
      type: String,
      default: null,
      maxlength: 300,
    },
  },
  {
    timestamps: true,
  }
);

pushSubscriptionSchema.index({ user: 1, endpoint: 1 }, { unique: true });

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);
export default PushSubscription;
