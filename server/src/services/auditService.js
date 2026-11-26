import mongoose from 'mongoose';
import AuditEvent from '../models/AuditEvent.js';

const SENSITIVE_KEY_PATTERN = /(password|token|secret|text|message|code|hash|key)/i;

function sanitizeMetadata(obj) {
  if (!obj || typeof obj !== 'object') return {};
  if (Array.isArray(obj)) return obj.map((v) => (typeof v === 'object' ? sanitizeMetadata(v) : v));

  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      continue;
    }
    clean[k] = v && typeof v === 'object' ? sanitizeMetadata(v) : v;
  }
  return clean;
}

/**
 * Append-only audit log helper.
 * Note: This data layer intentionally exposes ONLY create (audit) and read (queryAuditEvents)
 * operations. In production, the application DB user should also have update/delete
 * privileges revoked on the `auditevents` collection.
 */
export async function audit(action, ctx = {}) {
  try {
    const actor =
      ctx.actor && mongoose.isValidObjectId(ctx.actor) ? ctx.actor : null;

    await AuditEvent.create({
      at: new Date(),
      actor,
      action,
      targetType: ctx.targetType || null,
      targetId: ctx.targetId ? String(ctx.targetId) : null,
      ip: String(ctx.ip || '').slice(0, 64),
      userAgent: String(ctx.userAgent || '').slice(0, 300),
      requestId: String(ctx.requestId || '').slice(0, 64),
      metadata: sanitizeMetadata(ctx.metadata),
    });
  } catch (err) {
    // Audit write failures are logged without aborting user requests.
    console.error('[audit] Failed to write audit event:', err.message);
  }
}

export async function queryAuditEvents({
  actor,
  action,
  from,
  to,
  page = 1,
  limit = 50,
} = {}) {
  const filter = {};
  if (actor && mongoose.isValidObjectId(actor)) {
    filter.actor = actor;
  }
  if (action) {
    filter.action = action;
  }
  if (from || to) {
    filter.at = {};
    if (from) filter.at.$gte = new Date(from);
    if (to) filter.at.$lte = new Date(to);
  }

  const skip = (page - 1) * limit;
  const [events, total] = await Promise.all([
    AuditEvent.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
    AuditEvent.countDocuments(filter),
  ]);

  return {
    events: events.map((e) => ({
      ...e,
      _id: e._id.toString(),
      actor: e.actor ? e.actor.toString() : null,
      at: e.at instanceof Date ? e.at.toISOString() : e.at,
    })),
    page,
    limit,
    total,
    hasMore: skip + events.length < total,
  };
}
