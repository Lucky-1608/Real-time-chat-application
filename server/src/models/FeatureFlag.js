import mongoose from 'mongoose';

const featureFlagSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      enum: ['scheduledMessages', 'polls', 'uploads', 'aiSummaries'],
    },
    enabled: {
      type: Boolean,
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const FeatureFlag = mongoose.model('FeatureFlag', featureFlagSchema);
export default FeatureFlag;
