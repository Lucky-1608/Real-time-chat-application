import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import env from '../config/env.js';

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
const lastTouchedCache = new Map();

export function parseDeviceFromUserAgent(ua = '') {
  const s = String(ua || '');
  let browser = 'Unknown browser';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari';
  else if (/node|supertest|axios|curl/i.test(s)) browser = 'API Client';

  let os = 'Unknown OS';
  if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  return `${browser} on ${os}`;
}

export function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function createSession({ userId, userAgent = '', ip = '' }) {
  const rawRefreshToken = generateRefreshToken();
  const currentTokenHash = hashRefreshToken(rawRefreshToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const session = await Session.create({
    user: userId,
    familyId: crypto.randomUUID(),
    currentTokenHash,
    userAgent: String(userAgent || '').slice(0, 300),
    ip: String(ip || '').slice(0, 64),
    lastActiveAt: now,
    expiresAt,
  });

  return { session, rawRefreshToken };
}

/**
 * Atomically rotates a refresh token.
 * - Matches currentTokenHash -> rotates atomically via findOneAndUpdate.
 * - Matches previousTokenHash within REFRESH_GRACE_MS (10s) -> returns 'grace'
 *   without rotating again. Trade-off: tolerates concurrent multi-tab refreshes
 *   and flaky mobile networks at the cost of a 10s window before reuse triggers.
 * - Matches previousTokenHash outside grace window -> TOKEN REUSE -> revokes entire family.
 */
export async function rotateRefreshToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { status: 'invalid' };
  }

  const tokenHash = hashRefreshToken(rawToken);
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - env.REFRESH_IDLE_DAYS * 86_400_000);

  const nextRawToken = generateRefreshToken();
  const nextTokenHash = hashRefreshToken(nextRawToken);

  const rotated = await Session.findOneAndUpdate(
    {
      currentTokenHash: tokenHash,
      revokedAt: null,
      expiresAt: { $gt: now },
      lastActiveAt: { $gt: idleCutoff },
    },
    {
      $set: {
        previousTokenHash: tokenHash,
        currentTokenHash: nextTokenHash,
        rotatedAt: now,
        lastActiveAt: now,
      },
    },
    { new: true }
  );

  if (rotated) {
    return { status: 'rotated', session: rotated, rawRefreshToken: nextRawToken };
  }

  // Not the current active token; check if it was the immediately previous token.
  const existing = await Session.findOne({
    $or: [{ currentTokenHash: tokenHash }, { previousTokenHash: tokenHash }],
  });

  if (!existing || existing.revokedAt || existing.expiresAt <= now || existing.lastActiveAt <= idleCutoff) {
    return { status: 'invalid' };
  }

  if (existing.previousTokenHash === tokenHash && existing.rotatedAt) {
    const elapsedMs = now.getTime() - existing.rotatedAt.getTime();
    if (elapsedMs <= env.REFRESH_GRACE_MS) {
      return { status: 'grace', session: existing };
    }

    // Reuse outside grace window: revoke the entire token family immediately.
    const familySessions = await Session.find(
      { familyId: existing.familyId, revokedAt: null },
      { _id: 1 }
    ).lean();

    await Session.updateMany(
      { familyId: existing.familyId, revokedAt: null },
      { $set: { revokedAt: now, revokeReason: 'token_reuse' } }
    );

    console.warn(
      `[security] Refresh token reuse detected for user=${existing.user.toString()} family=${existing.familyId}`
    );

    return {
      status: 'reuse_detected',
      userId: existing.user.toString(),
      revokedSessionIds: familySessions.map((s) => s._id.toString()),
    };
  }

  return { status: 'invalid' };
}

export async function revokeSessionByToken(rawToken, reason = 'logout') {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashRefreshToken(rawToken);
  return Session.findOneAndUpdate(
    {
      $or: [{ currentTokenHash: tokenHash }, { previousTokenHash: tokenHash }],
      revokedAt: null,
    },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
    { new: true }
  );
}

export async function revokeAllUserSessions(
  userId,
  reason = 'logout_all',
  { exceptSessionId } = {}
) {
  const filter = { user: userId, revokedAt: null };
  if (exceptSessionId && mongoose.isValidObjectId(exceptSessionId)) {
    filter._id = { $ne: exceptSessionId };
  }

  const active = await Session.find(filter, { _id: 1 }).lean();
  if (active.length === 0) return [];

  await Session.updateMany(filter, { $set: { revokedAt: new Date(), revokeReason: reason } });
  return active.map((s) => s._id.toString());
}

export async function listUserSessions(userId, currentSid) {
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - env.REFRESH_IDLE_DAYS * 86_400_000);

  const docs = await Session.find(
    {
      user: userId,
      revokedAt: null,
      expiresAt: { $gt: now },
      lastActiveAt: { $gt: idleCutoff },
    },
    {
      currentTokenHash: 0,
      previousTokenHash: 0,
    }
  )
    .sort({ lastActiveAt: -1 })
    .lean();

  return docs.map((s) => ({
    id: s._id.toString(),
    device: parseDeviceFromUserAgent(s.userAgent),
    ip: s.ip || 'Unknown',
    createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
    lastActiveAt: s.lastActiveAt instanceof Date ? s.lastActiveAt.toISOString() : s.lastActiveAt,
    expiresAt: s.expiresAt instanceof Date ? s.expiresAt.toISOString() : s.expiresAt,
    isCurrent: s._id.toString() === currentSid?.toString(),
  }));
}

export async function revokeUserSessionById(sessionId, userId, reason = 'revoked_by_user') {
  if (!mongoose.isValidObjectId(sessionId)) return null;
  return Session.findOneAndUpdate(
    { _id: sessionId, user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
    { new: true }
  );
}

/**
 * Throttles lastActiveAt updates to at most once every 5 minutes per session
 * to avoid issuing a MongoDB write on every authenticated read request.
 */
export function touchSessionActivity(sessionId) {
  if (!sessionId || !mongoose.isValidObjectId(sessionId)) return;
  const key = sessionId.toString();
  const now = Date.now();
  const prev = lastTouchedCache.get(key) || 0;
  if (now - prev < LAST_ACTIVE_THROTTLE_MS) return;

  lastTouchedCache.set(key, now);
  Session.updateOne({ _id: key, revokedAt: null }, { $set: { lastActiveAt: new Date(now) } }).catch(
    () => {}
  );
}

export async function isSessionActive(sessionId) {
  if (!sessionId) return false;
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - env.REFRESH_IDLE_DAYS * 86_400_000);
  const count = await Session.countDocuments({
    _id: sessionId,
    revokedAt: null,
    expiresAt: { $gt: now },
    lastActiveAt: { $gt: idleCutoff },
  });
  return count > 0;
}
