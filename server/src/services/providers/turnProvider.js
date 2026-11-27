import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = 300;

export function createMockTurnProvider() {
  return {
    name: 'mock-turn',
    async getIceServers() {
      return {
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        ttlSeconds: DEFAULT_TTL_SECONDS,
      };
    },
  };
}

export function createCoturnProvider({
  urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sharedSecret = process.env.TURN_SHARED_SECRET,
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  if (!sharedSecret || urls.length === 0) {
    return createMockTurnProvider();
  }

  return {
    name: 'coturn',
    async getIceServers(userId) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiresAt}:${userId}`;
      const credential = crypto
        .createHmac('sha1', sharedSecret)
        .update(username)
        .digest('base64');

      return {
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          {
            urls,
            username,
            credential,
          },
        ],
        ttlSeconds,
      };
    },
  };
}

export const defaultTurnProvider = createCoturnProvider();
