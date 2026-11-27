import crypto from 'node:crypto';
import OutgoingWebhook from '../../models/OutgoingWebhook.js';
import OutgoingDeliveryJob from '../../models/OutgoingDeliveryJob.js';
import { decryptField } from '../cryptoService.js';
import { audit } from '../auditService.js';
import { safeWebhookRequest } from '../security/ssrfGuard.js';

const DEFAULT_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 6;

export function signOutgoingPayload(secret, timestampSec, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`)
    .digest('hex');
}

export function createOutgoingDispatcher({
  nowFn = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  requestOptions = {},
} = {}) {
  async function enqueueEvent({ workspaceId, roomId = null, event, payload }) {
    if (!workspaceId || !event) return 0;

    const roomFilter = roomId ? { $in: [null, roomId] } : null;
    const hooks = await OutgoingWebhook.find({
      workspace: workspaceId,
      enabled: true,
      events: event,
      ...(roomFilter ? { room: roomFilter } : {}),
    }).lean();

    if (hooks.length === 0) return 0;

    const eventId = crypto.randomUUID();
    const jobs = hooks.map((h) => ({
      webhook: h._id,
      workspace: workspaceId,
      room: roomId || null,
      event,
      eventId,
      deliveryId: crypto.randomUUID(),
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      nextAttemptAt: nowFn(),
    }));

    await OutgoingDeliveryJob.insertMany(jobs);
    return jobs.length;
  }

  async function processNextDelivery() {
    const now = nowFn();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    const job = await OutgoingDeliveryJob.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'processing', leaseUntil: { $lt: now } },
        ],
      },
      { $set: { status: 'processing', leaseUntil } },
      { sort: { nextAttemptAt: 1 }, new: true }
    );

    if (!job) return false;

    const hook = await OutgoingWebhook.findById(job.webhook).lean();
    if (!hook || !hook.enabled) {
      await OutgoingDeliveryJob.updateOne(
        { _id: job._id },
        { $set: { status: 'dead_letter', leaseUntil: null, lastError: 'Webhook disabled' } }
      );
      return true;
    }

    const attemptNum = (job.attempts || 0) + 1;
    const timestampSec = Math.floor(now.getTime() / 1000).toString();
    const body = JSON.stringify({
      eventId: job.eventId,
      deliveryId: job.deliveryId,
      event: job.event,
      workspaceId: job.workspace.toString(),
      roomId: job.room ? job.room.toString() : null,
      timestamp: now.toISOString(),
      data: job.payload,
    });

    try {
      const secret = decryptField(hook.signingSecretEnc);
      const sig = signOutgoingPayload(secret, timestampSec, body);
      const res = await safeWebhookRequest(
        hook.url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-PulseChat-Event': job.event,
            'X-PulseChat-Event-Id': job.eventId,
            'X-PulseChat-Delivery': job.deliveryId,
            'X-PulseChat-Signature-256': `t=${timestampSec},v1=${sig}`,
          },
          body,
        },
        requestOptions
      );

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}`);
      }

      await Promise.all([
        OutgoingDeliveryJob.updateOne(
          { _id: job._id },
          { $set: { status: 'delivered', attempts: attemptNum, leaseUntil: null, lastError: null } }
        ),
        OutgoingWebhook.updateOne({ _id: hook._id }, { $set: { failureCount: 0 } }),
      ]);
      return true;
    } catch (err) {
      const errMsg = err?.message || 'Delivery failed';
      if (attemptNum >= (job.maxAttempts || MAX_ATTEMPTS)) {
        await OutgoingDeliveryJob.updateOne(
          { _id: job._id },
          { $set: { status: 'dead_letter', attempts: attemptNum, leaseUntil: null, lastError: errMsg } }
        );
        const updatedHook = await OutgoingWebhook.findOneAndUpdate(
          { _id: hook._id },
          {
            $inc: { failureCount: 1 },
            $set: { enabled: false, disabledReason: `Auto-disabled after ${attemptNum} failures: ${errMsg}` },
          },
          { new: true }
        );
        await audit('webhook.outgoing.auto_disabled', {
          targetType: 'OutgoingWebhook',
          targetId: hook._id.toString(),
          metadata: { workspaceId: hook.workspace.toString(), failureCount: updatedHook?.failureCount },
        });
      } else {
        const backoffMs = Math.min(2 ** attemptNum * 1000, 60_000);
        await OutgoingDeliveryJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'pending',
              attempts: attemptNum,
              nextAttemptAt: new Date(now.getTime() + backoffMs),
              leaseUntil: null,
              lastError: errMsg,
            },
          }
        );
        await OutgoingWebhook.updateOne({ _id: hook._id }, { $inc: { failureCount: 1 } });
      }
      return true;
    }
  }

  return {
    enqueueEvent,
    processNextDelivery,
  };
}

export const defaultOutgoingDispatcher = createOutgoingDispatcher();
