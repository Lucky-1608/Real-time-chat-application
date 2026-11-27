import crypto from 'node:crypto';

const SIGNATURE_TOLERANCE_SEC = 300;

export function createMockPaymentProvider({
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dev_mock_secret',
} = {}) {
  return {
    name: 'mock-payment',
    async createCheckoutSession({ workspaceId, plan, userId }) {
      return {
        sessionId: `cs_mock_${crypto.randomBytes(8).toString('hex')}`,
        checkoutUrl: `https://checkout.stripe.com/pay/mock?ws=${workspaceId}&plan=${plan}&u=${userId}`,
      };
    },
    verifyWebhookSignature(rawBody, signatureHeader) {
      if (!rawBody || !signatureHeader) return false;
      const parts = Object.fromEntries(
        String(signatureHeader)
          .split(',')
          .map((kv) => kv.split('='))
          .filter(([k, v]) => k && v)
      );
      const ts = Number(parts.t);
      const v1 = parts.v1;
      if (!ts || !v1) return false;

      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) {
        return false;
      }

      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${ts}.${rawBody}`)
        .digest('hex');

      const a = Buffer.from(v1, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

export const defaultPaymentProvider = createMockPaymentProvider();
