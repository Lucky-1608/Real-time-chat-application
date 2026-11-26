import { Router } from 'express';
import mongoose from 'mongoose';
import Message, { serializeMessage, serializePoll } from '../models/Message.js';
import StarredMessage from '../models/StarredMessage.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { messagesQuerySchema, objectIdSchema, votePollSchema } from '../utils/validators.js';
import { AppError } from '../middleware/errorHandler.js';
import { ensureGeneralRoom } from '../services/roomMigration.js';
import { getRoomIfMember } from '../services/roomAccess.js';
import { can } from '../services/permissions.js';

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

  // POST /api/messages/:id/vote — atomic, idempotent poll vote
  router.post(
    '/:id/vote',
    asyncHandler(async (req, res) => {
      const idParsed = objectIdSchema.safeParse(req.params.id);
      if (!idParsed.success) throw new AppError('Invalid message ID', 400);
      const bodyParsed = votePollSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0]?.message || 'Invalid vote payload', 400);
      }

      const msg = await Message.findById(idParsed.data);
      if (!msg || msg.deletedAt || msg.kind !== 'poll' || !msg.poll) {
        throw new AppError('Poll not found', 404);
      }

      await getRoomIfMember(msg.room.toString(), req.user.id);

      const isClosed =
        Boolean(msg.poll.closedAt) ||
        (msg.poll.closesAt && new Date(msg.poll.closesAt).getTime() <= Date.now());
      if (isClosed) {
        throw new AppError('This poll is closed', 400);
      }

      const uniqueOptions = [...new Set(bodyParsed.data.optionIds)];
      if (!msg.poll.multiple && uniqueOptions.length > 1) {
        throw new AppError('This poll only allows a single choice', 400);
      }

      const validIds = new Set(msg.poll.options.map((o) => o.id));
      if (!uniqueOptions.every((id) => validIds.has(id))) {
        throw new AppError('Invalid poll option', 400);
      }

      const userObjectId = new mongoose.Types.ObjectId(req.user.id);
      // Atomic per-user vote replacement: pulling only this user's ID and $addToSet
      // ensures concurrent votes from multiple users never overwrite each other.
      await Message.updateOne(
        { _id: msg._id },
        { $pull: { 'poll.options.$[].votes': userObjectId } }
      );
      await Message.updateOne(
        { _id: msg._id },
        { $addToSet: { 'poll.options.$[opt].votes': userObjectId } },
        { arrayFilters: [{ 'opt.id': { $in: uniqueOptions } }] }
      );

      const updated = await Message.findById(msg._id, { poll: 1, room: 1 }).lean();
      const poll = serializePoll(updated.poll);
      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${updated.room.toString()}`).emit('poll:updated', {
          roomId: updated.room.toString(),
          messageId: msg._id.toString(),
          poll,
        });
      }

      res.status(200).json({ poll });
    })
  );

  // POST /api/messages/:id/poll/close — creator or moderator+ closes poll early
  router.post(
    '/:id/poll/close',
    asyncHandler(async (req, res) => {
      const idParsed = objectIdSchema.safeParse(req.params.id);
      if (!idParsed.success) throw new AppError('Invalid message ID', 400);

      const msg = await Message.findById(idParsed.data);
      if (!msg || msg.deletedAt || msg.kind !== 'poll' || !msg.poll) {
        throw new AppError('Poll not found', 404);
      }

      const { room } = await getRoomIfMember(msg.room.toString(), req.user.id);
      const isCreator = msg.sender.toString() === req.user.id;
      if (!isCreator && !can(req.user, 'message.delete_any', { room })) {
        throw new AppError('Only the poll creator or a moderator can close this poll', 403);
      }

      if (!msg.poll.closedAt) {
        msg.poll.closedAt = new Date();
        await msg.save();
      }

      const poll = serializePoll(msg.poll);
      const io = req.app.locals.io;
      if (io) {
        io.to(`room:${room._id.toString()}`).emit('poll:updated', {
          roomId: room._id.toString(),
          messageId: msg._id.toString(),
          poll,
        });
      }

      res.status(200).json({ poll });
    })
  );

  return router;
}
