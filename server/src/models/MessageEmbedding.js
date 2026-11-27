import mongoose from 'mongoose';
import { tenantPlugin } from '../services/tenantScope.js';

const messageEmbeddingSchema = new mongoose.Schema(
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
    message: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
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
    textSnippet: {
      type: String,
      required: true,
      maxlength: 400,
    },
    vector: {
      type: [Number],
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

messageEmbeddingSchema.index({ workspace: 1, message: 1 }, { unique: true });
messageEmbeddingSchema.index({ workspace: 1, room: 1, createdAt: -1 });
messageEmbeddingSchema.plugin(tenantPlugin);

const MessageEmbedding = mongoose.model('MessageEmbedding', messageEmbeddingSchema);
export default MessageEmbedding;
