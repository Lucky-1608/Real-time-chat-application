import env from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

const SPAM_WINDOW_MS = 60_000;
const MAX_DUPLICATE_TEXTS = 3;
const MAX_URLS_PER_MESSAGE = 5;

export function createFloodControl({
  newAccountMinutes = env.NEW_ACCOUNT_RESTRICTION_MINUTES,
} = {}) {
  const slowModeLastSent = new Map(); // `${roomId}:${userId}` -> timestampMs
  const recentTextHistory = new Map(); // userId -> [{ textLower, atMs }]

  function isNewAccount(userCreatedAt) {
    if (!newAccountMinutes || newAccountMinutes <= 0 || !userCreatedAt) return false;
    const ageMs = Date.now() - new Date(userCreatedAt).getTime();
    return ageMs < newAccountMinutes * 60_000;
  }

  function assertNewAccountAllowed(userCreatedAt, actionLabel) {
    if (isNewAccount(userCreatedAt)) {
      throw new AppError(
        `New accounts cannot ${actionLabel} during the first ${newAccountMinutes} minutes`,
        403
      );
    }
  }

  function checkSlowMode({ roomId, userId, slowModeSeconds }) {
    if (!slowModeSeconds || slowModeSeconds <= 0) return { ok: true };
    const key = `${roomId}:${userId}`;
    const now = Date.now();
    const last = slowModeLastSent.get(key) || 0;
    const elapsedSec = (now - last) / 1000;
    if (elapsedSec < slowModeSeconds) {
      const remaining = Math.ceil(slowModeSeconds - elapsedSec);
      return {
        ok: false,
        error: `Slow mode is enabled. Please wait ${remaining}s before sending another message.`,
      };
    }
    slowModeLastSent.set(key, now);
    return { ok: true };
  }

  function checkSpam({ userId, text }) {
    if (!text) return { ok: true };

    const urlMatches = text.match(/https?:\/\/\S+/gi) || [];
    if (urlMatches.length > MAX_URLS_PER_MESSAGE) {
      return { ok: false, error: 'Too many links in a single message (spam protection).' };
    }

    const normalized = text.trim().toLowerCase();
    const now = Date.now();
    const entries = (recentTextHistory.get(userId) || []).filter(
      (e) => now - e.atMs < SPAM_WINDOW_MS
    );
    const sameCount = entries.filter((e) => e.textLower === normalized).length;

    if (sameCount >= MAX_DUPLICATE_TEXTS) {
      return { ok: false, error: 'Duplicate message spam detected. Please slow down.' };
    }

    entries.push({ textLower: normalized, atMs: now });
    recentTextHistory.set(userId, entries);
    return { ok: true };
  }

  return {
    isNewAccount,
    assertNewAccountAllowed,
    checkSlowMode,
    checkSpam,
  };
}

export const defaultFloodControl = createFloodControl();
