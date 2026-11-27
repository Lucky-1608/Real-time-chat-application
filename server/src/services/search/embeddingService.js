import MessageEmbedding from '../../models/MessageEmbedding.js';
import Room from '../../models/Room.js';
import Workspace from '../../models/Workspace.js';
import { defaultEmbeddingProvider } from '../providers/embeddingProvider.js';

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function indexMessageEmbedding(
  messageDoc,
  { embeddingProvider = defaultEmbeddingProvider } = {}
) {
  if (!messageDoc?.text || messageDoc.deletedAt || !messageDoc.workspace) {
    return { skipped: true, reason: 'Empty or deleted message' };
  }

  if (embeddingProvider.name !== 'mock-embedding') {
    const ws = await Workspace.findById(messageDoc.workspace, { settings: 1 }).lean();
    if (!ws?.settings?.allowExternalProcessing) {
      return { skipped: true, reason: 'Blocked by workspace allowExternalProcessing setting' };
    }
  }

  const vector = await embeddingProvider.embed(messageDoc.text);
  if (!vector || vector.length === 0) {
    return { skipped: true, reason: 'Empty embedding vector' };
  }

  await MessageEmbedding.updateOne(
    { workspace: messageDoc.workspace, message: messageDoc._id },
    {
      $set: {
        workspace: messageDoc.workspace,
        room: messageDoc.room,
        message: messageDoc._id,
        sender: messageDoc.sender,
        senderName: messageDoc.senderName,
        textSnippet: String(messageDoc.text).slice(0, 400),
        vector,
      },
    },
    { upsert: true }
  );

  return { skipped: false };
}

export async function removeMessageEmbedding(workspaceId, messageId) {
  if (!workspaceId || !messageId) return;
  await MessageEmbedding.deleteOne({ workspace: workspaceId, message: messageId });
}

export async function semanticSearchMessages({
  workspaceId,
  userId,
  query,
  roomId = null,
  limit = 10,
  embeddingProvider = defaultEmbeddingProvider,
}) {
  if (embeddingProvider.name !== 'mock-embedding') {
    const ws = await Workspace.findById(workspaceId, { settings: 1 }).lean();
    if (!ws?.settings?.allowExternalProcessing) {
      return { blockedByPolicy: true, results: [] };
    }
  }

  const memberRooms = await Room.find(
    {
      workspace: workspaceId,
      'members.user': userId,
      ...(roomId ? { _id: roomId } : {}),
    },
    { _id: 1, name: 1, type: 1 }
  ).lean();

  if (memberRooms.length === 0) {
    return { blockedByPolicy: false, results: [] };
  }

  const roomIds = memberRooms.map((r) => r._id);
  const roomNameById = new Map(memberRooms.map((r) => [r._id.toString(), r.name || 'Direct Message']));

  const queryVec = await embeddingProvider.embed(query);
  const candidates = await MessageEmbedding.find({
    workspace: workspaceId,
    room: { $in: roomIds },
  })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  const scored = candidates
    .map((c) => ({
      messageId: c.message.toString(),
      roomId: c.room.toString(),
      roomName: roomNameById.get(c.room.toString()) || 'Room',
      senderId: c.sender.toString(),
      senderName: c.senderName,
      text: c.textSnippet,
      score: Number(cosineSimilarity(queryVec, c.vector).toFixed(4)),
      createdAt: c.createdAt,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 25));

  return { blockedByPolicy: false, results: scored };
}
