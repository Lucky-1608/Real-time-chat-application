export function createMockEmailProvider() {
  return {
    name: 'mock-email',
    async send() {
      return { ok: true };
    },
  };
}

export const defaultEmailProvider = createMockEmailProvider();
