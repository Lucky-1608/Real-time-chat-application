import env from '../config/env.js';

/**
 * Scrubs PII (message text, tokens, passwords, emails, auth headers) before
 * any error event is sent to Sentry. Acts as a no-op when SENTRY_DSN is unset.
 */
export function scrubSentryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const cloned = structuredClone(event);

  if (cloned.request?.headers) {
    if (cloned.request.headers.authorization) cloned.request.headers.authorization = '[Redacted]';
    if (cloned.request.headers.cookie) cloned.request.headers.cookie = '[Redacted]';
  }
  if (cloned.user) {
    delete cloned.user.email;
    delete cloned.user.ip_address;
  }
  if (cloned.extra) {
    for (const key of ['text', 'message', 'token', 'refreshToken', 'password', 'secret']) {
      if (key in cloned.extra) {
        cloned.extra[key] = '[Redacted]';
      }
    }
  }
  return cloned;
}

export function captureException(err, context = {}) {
  if (!env.SENTRY_DSN) {
    return null;
  }
  const event = scrubSentryEvent({
    message: err?.message || 'Unknown error',
    release: env.APP_VERSION || '1.0.0',
    extra: context,
  });
  return event;
}
