import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { generateSecret, generateSync, generateURI } from 'otplib';
import QRCode from 'qrcode';
import env from '../config/env.js';
import User from '../models/User.js';
import { AppError } from '../middleware/errorHandler.js';

const TOTP_STEP_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .replace(/[\s-]+/g, '')
    .toUpperCase();
}

export function hashRecoveryCode(rawCode) {
  return crypto.createHash('sha256').update(normalizeCode(rawCode)).digest('hex');
}

export async function generateTotpSetup(username) {
  const secret = generateSecret();
  const otpauthUri = generateURI({ issuer: 'PulseChat', label: username, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUri);
  return { secret, otpauthUri, qrDataUrl };
}

/**
 * Verifies a 6-digit TOTP within +/- 1 time step (30s each) for clock drift,
 * while rejecting any step at or before lastAcceptedStep to prevent replay attacks.
 */
export function verifyTotpWithReplayCheck(secret, rawCode, lastAcceptedStep = null) {
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code) || !secret) {
    return { valid: false };
  }

  const currentStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);

  for (const delta of [-1, 0, 1]) {
    const candidateStep = currentStep + delta;
    const expected = generateSync({
      secret,
      epoch: candidateStep * TOTP_STEP_SECONDS,
    });
    const match =
      expected.length === code.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code));

    if (match) {
      if (lastAcceptedStep !== null && candidateStep <= lastAcceptedStep) {
        return { valid: false, replayed: true };
      }
      return { valid: true, step: candidateStep };
    }
  }

  return { valid: false };
}

export function generateRecoveryCodes() {
  const plaintextCodes = [];
  const hashedEntries = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    plaintextCodes.push(formatted);
    hashedEntries.push({ hash: hashRecoveryCode(formatted), usedAt: null });
  }
  return { plaintextCodes, hashedEntries };
}

export async function consumeRecoveryCode(userId, rawCode) {
  const hash = hashRecoveryCode(rawCode);
  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      recoveryCodeHashes: { $elemMatch: { hash, usedAt: null } },
    },
    {
      $set: { 'recoveryCodeHashes.$.usedAt': new Date() },
    },
    { new: true }
  );
  return Boolean(updated);
}

export function signMfaPendingToken(userId) {
  return jwt.sign({ sub: userId, purpose: 'mfa_pending' }, env.JWT_SECRET, {
    expiresIn: '5m',
  });
}

export function verifyMfaPendingToken(token) {
  if (!token || typeof token !== 'string') {
    throw new AppError('Invalid or expired MFA session', 401);
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload?.purpose !== 'mfa_pending' || !payload?.sub) {
      throw new AppError('Invalid or expired MFA session', 401);
    }
    return { userId: payload.sub };
  } catch {
    throw new AppError('Invalid or expired MFA session', 401);
  }
}
