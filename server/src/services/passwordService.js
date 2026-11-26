import crypto from 'node:crypto';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import env from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

const HIBP_TIMEOUT_MS = 1500;
const BACKOFF_SCHEDULE_SECONDS = [30, 60, 300, 900]; // 30s, 1m, 5m, 15m (capped)

export function getBackoffSeconds(failedAttempts) {
  if (failedAttempts < 5) return 0;
  const idx = Math.min(failedAttempts - 5, BACKOFF_SCHEDULE_SECONDS.length - 1);
  return BACKOFF_SCHEDULE_SECONDS[idx];
}

/**
 * Checks the Have I Been Pwned k-anonymity range API (only the first 5 chars
 * of SHA-1 are sent, with Add-Padding). Fails OPEN on timeout/network error
 * so an external HIBP outage never blocks user registration or password changes.
 */
export async function checkBreachedPassword(
  password,
  { fetchFn = fetch, timeoutMs = HIBP_TIMEOUT_MS } = {}
) {
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[security] HIBP API returned status ${res.status}; failing open`);
      return;
    }

    const body = await res.text();
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const [hashSuffix, countStr] = line.split(':');
      if (hashSuffix === suffix && Number(countStr) > 0) {
        throw new AppError(
          'This password has appeared in a known data breach. Please choose a different password.',
          400
        );
      }
    }
  } catch (err) {
    if (err.isOperational) throw err;
    console.warn('[security] HIBP check unavailable; failing open:', err.message);
  } finally {
    clearTimeout(timer);
  }
}

export function createPasswordService({
  pepper = env.PASSWORD_PEPPER,
  memoryCost = env.ARGON2_MEMORY_KB,
  timeCost = env.ARGON2_TIME_COST,
  parallelism = env.ARGON2_PARALLELISM,
  hibpEnabled = env.HIBP_ENABLED === 'true',
} = {}) {
  let dummyHashPromise = null;

  // Optional HMAC pepper before hashing.
  // WARNING: Losing PASSWORD_PEPPER invalidates all existing password hashes and forces password resets.
  function applyPepper(password) {
    if (!pepper) return password;
    return crypto.createHmac('sha256', pepper).update(password).digest('hex');
  }

  async function hashPassword(password) {
    return argon2.hash(applyPepper(password), {
      type: argon2.argon2id,
      memoryCost,
      timeCost,
      parallelism,
    });
  }

  async function getDummyHash() {
    if (!dummyHashPromise) {
      dummyHashPromise = hashPassword('constant-time-dummy-password-for-unknown-users');
    }
    return dummyHashPromise;
  }

  async function verifyDummyPassword(password) {
    const dummy = await getDummyHash();
    await argon2.verify(dummy, applyPepper(password)).catch(() => false);
    return false;
  }

  async function verifyPassword(password, storedHash) {
    if (!storedHash) {
      await verifyDummyPassword(password);
      return { valid: false, needsRehash: false };
    }

    // Legacy bcrypt hashes are verified and transparently upgraded to argon2id on login.
    if (storedHash.startsWith('$2')) {
      const valid = await bcrypt.compare(password, storedHash);
      return { valid, needsRehash: valid };
    }

    try {
      const valid = await argon2.verify(storedHash, applyPepper(password));
      return { valid, needsRehash: false };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }

  async function ensureNotBreached(password) {
    if (!hibpEnabled) return;
    await checkBreachedPassword(password);
  }

  return {
    hashPassword,
    verifyPassword,
    verifyDummyPassword,
    ensureNotBreached,
  };
}

export const defaultPasswordService = createPasswordService();
