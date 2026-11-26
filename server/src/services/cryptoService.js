import crypto from 'node:crypto';
import env from '../config/env.js';

function deriveKey32(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey)).digest();
}

function buildKeyRing() {
  const ring = new Map();
  ring.set(env.ENCRYPTION_KEY_ID, deriveKey32(env.ENCRYPTION_KEY));

  if (env.ENCRYPTION_PREVIOUS_KEYS) {
    try {
      const parsed = JSON.parse(env.ENCRYPTION_PREVIOUS_KEYS);
      for (const [id, key] of Object.entries(parsed)) {
        if (id && key) ring.set(id, deriveKey32(key));
      }
    } catch {
      // Invalid JSON is ignored; primary key remains active
    }
  }
  return ring;
}

/**
 * Encrypts a UTF-8 string using AES-256-GCM and prefixes the keyId so
 * encryption keys can be rotated without breaking existing records.
 */
export function encryptField(
  plaintext,
  { keyId = env.ENCRYPTION_KEY_ID, key = env.ENCRYPTION_KEY } = {}
) {
  if (plaintext === null || plaintext === undefined) return null;
  const keyBuf = deriveKey32(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${keyId}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptField(payload, { keysById } = {}) {
  if (!payload || typeof payload !== 'string') return null;
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted payload');
  }
  const [keyId, ivHex, tagHex, cipherHex] = parts;
  const ring = keysById || buildKeyRing();
  const rawOrBuf = ring.get(keyId);
  if (!rawOrBuf) {
    throw new Error(`Unknown encryption keyId: ${keyId}`);
  }
  const keyBuf = Buffer.isBuffer(rawOrBuf) ? rawOrBuf : deriveKey32(rawOrBuf);

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function rotateEncryptedField(
  payload,
  { keysById, newKeyId = env.ENCRYPTION_KEY_ID, newKey = env.ENCRYPTION_KEY } = {}
) {
  const plaintext = decryptField(payload, { keysById });
  if (plaintext === null) return null;
  return encryptField(plaintext, { keyId: newKeyId, key: newKey });
}
