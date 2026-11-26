import { Router } from 'express';
import Message, { serializeMessage } from '../models/Message.js';
import StarredMessage from '../models/StarredMessage.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { messagesQuerySchema, objectIdSchema } from '../utils/validators.js';
import { AppError } from '../middleware/errorHandler.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';
import { getRoomIfMember } from '../services/roomAccess.js';

export function createMessagesRouter() {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = messagesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid query parameters', 400);
      }

      const { before, after, limit, roomId } = parsed.data;
      const targetRoomId = roomId || (await ensureGeneralRoom()).room._id.toString();
      const { room } = await getRoomIfMember(targetRoomId, req.user.id);

      if (after) {
        const docs = await Message.find({
          room: room._id,
          createdAt: { $gt: new Date(after) },
        })
          .sort({ createdAt: 1 })
          .limit(limit)
          .lean();

        return res.status(200).json({
          messages: docs.map(serializeMessage),
          hasMore: false,
        });
      }

      const filter = { room: room._id };
      if (before) {
        filter.createdAt = { $lt: new Date(before) };
      }

      // Fetch one extra document to determine if older messages exist without a separate countDocuments query.
      const docs = await Message.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = docs.length > limit;
      const page = hasMore ? docs.slice(0, limit) : docs;

      // Reverse to oldest-first order for direct chronological rendering in the client.
      page.reverse();

      return res.status(200).json({
        messages: page.map(serializeMessage),
        hasMore,
      });
    })
  );

  router.post(
    '/:id/star',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid message ID', 400);

      const msg = await Message.findById(parsed.data, { room: 1, deletedAt: 1 }).lean();
      if (!msg || msg.deletedAt) throw new AppError('Message not found', 404);

      await getRoomIfMember(msg.room.toString(), req.user.id);

      await StarredMessage.updateOne(
        { user: req.user.id, message: msg._id },
        { $setOnInsert: { user: req.user.id, message: msg._id, room: msg.room } },
        { upsert: true }
      );

      res.status(200).json({ ok: true, messageId: msg._id.toString(), starred: true });
    })
  );

  router.delete(
    '/:id/star',
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new AppError('Invalid message ID', 400);

      await StarredMessage.deleteOne({ user: req.user.id, message: parsed.data });
      res.status(200).json({ ok: true, messageId: parsed.data, starred: false });
    })
  );

  return router;
}
