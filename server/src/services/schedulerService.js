import ScheduledMessage from '../models/ScheduledMessage.js';
import Message from '../models/Message.js';
import { getRoomIfMember } from './roomAccess.js';
import { deliverMessage } from './messageService.js';
import { defaultStorageService } from './storage.js';
import { defaultFloodControl } from './floodControl.js';

const DEFAULT_LEASE_MS = 60_000;

/**
 * Polls due scheduled messages and expired disappearing messages.
 *
 * Trade-off (at-least-once vs exactly-once):
 * We use atomic `findOneAndUpdate` with a `leaseUntil` timestamp to claim jobs
 * (at-least-once if a worker crashes mid-flight after creating the Message).
 * Sending is made idempotent via `Message.scheduledKey` (unique sparse index),
 * preventing duplicate messages even across retries.
 */
export function createSchedulerService({
  io = null,
  presence = null,
  storageService = defaultStorageService,
  floodControl = defaultFloodControl,
  nowFn = () => new Date(),
  pollIntervalMs = 5000,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  let timer = null;
  let running = false;

  async function processNextScheduled() {
    const now = nowFn();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    const job = await ScheduledMessage.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', sendAt: { $lte: now } },
          { status: 'processing', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'processing', leaseUntil },
      },
      {
        sort: { sendAt: 1 },
        new: true,
      }
    );

    if (!job) return false;

    try {
      const { room } = await getRoomIfMember(job.room.toString(), job.sender.toString());
      const res = await deliverMessage({
        room,
        userId: job.sender.toString(),
        username: job.senderName,
        text: job.text,
        scheduledKey: job.idempotencyKey,
        io,
        presence,
        storageService,
        floodControl,
      });

      if (!res.ok) {
        await ScheduledMessage.updateOne(
          { _id: job._id },
          { $set: { status: 'failed', failureReason: res.error, leaseUntil: null } }
        );
        return true;
      }

      await ScheduledMessage.updateOne(
        { _id: job._id },
        { $set: { status: 'sent', sentMessageId: res.id, leaseUntil: null } }
      );
      return true;
    } catch (err) {
      const status = err.isOperational ? 'failed' : 'pending';
      await ScheduledMessage.updateOne(
        { _id: job._id },
        {
          $set: {
            status,
            failureReason: err.isOperational ? err.message : null,
            leaseUntil: null,
          },
        }
      );
      return status === 'failed';
    }
  }

  async function sweepExpiredMessages() {
    const now = nowFn();
    const expiredDocs = await Message.find({
      expiresAt: { $ne: null, $lte: now },
    })
      .limit(100)
      .lean();

    if (expiredDocs.length === 0) return 0;

    for (const msg of expiredDocs) {
      for (const att of msg.attachments || []) {
        await storageService.deleteObject(att.key).catch(() => {});
      }
      await Message.deleteOne({ _id: msg._id });
      if (io) {
        const roomId = msg.room.toString();
        io.to(`room:${roomId}`).emit('message:deleted', {
          roomId,
          messageId: msg._id.toString(),
          deletedAt: now.toISOString(),
          expired: true,
        });
      }
    }

    return expiredDocs.length;
  }

  async function runTick() {
    if (running) return;
    running = true;
    try {
      while (await processNextScheduled()) {
        // Drain due/overdue scheduled jobs
      }
      await sweepExpiredMessages();
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    // Process any overdue jobs immediately on startup after downtime.
    runTick().catch((err) => console.error('[scheduler] Startup tick error:', err));
    timer = setInterval(() => {
      runTick().catch((err) => console.error('[scheduler] Tick error:', err));
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { processNextScheduled, sweepExpiredMessages, runTick, start, stop };
}
