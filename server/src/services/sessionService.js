import crypto from 'node:crypto';
import Session from '../models/Session.js';
import env from '../config/env.js';

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

export async function revokeAllUserSessions(userId, reason = 'logout_all') {
  const active = await Session.find({ user: userId, revokedAt: null }, { _id: 1 }).lean();
  await Session.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } }
  );
  return active.map((s) => s._id.toString());
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
