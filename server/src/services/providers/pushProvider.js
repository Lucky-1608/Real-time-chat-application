export function createMockPushProvider() {
  return {
    name: 'mock-push',
    publicKey: process.env.VAPID_PUBLIC_KEY || 'mock-vapid-public-key',
    async send() {
      return { ok: true };
    },
  };
}

export const defaultPushProvider = createMockPushProvider();
