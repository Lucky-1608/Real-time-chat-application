import mongoose from 'mongoose';

const auditEventSchema = new mongoose.Schema(
  {
    at: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      default: null,
    },
    targetId: {
      type: String,
      default: null,
    },
    ip: {
      type: String,
      default: '',
    },
    userAgent: {
      type: String,
      default: '',
    },
    requestId: {
      type: String,
      default: '',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    versionKey: false,
  }
);

auditEventSchema.index({ actor: 1, at: -1 });
auditEventSchema.index({ action: 1, at: -1 });

const AuditEvent = mongoose.model('AuditEvent', auditEventSchema);
export default AuditEvent;
