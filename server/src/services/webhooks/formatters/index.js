import crypto from 'node:crypto';
import { z } from 'zod';
import { decryptField } from '../../cryptoService.js';

const safeHttpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((val) => {
    try {
      const u = new URL(val);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Attachment URL must use http or https scheme');

const genericAttachmentSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(500),
    url: safeHttpUrlSchema.optional(),
  })
  .strict();

export const genericWebhookPayloadSchema = z
  .object({
    text: z.string().trim().min(1, 'text is required').max(1500),
    username: z.string().trim().min(1).max(40).optional(),
    attachments: z.array(genericAttachmentSchema).max(5).optional(),
  })
  .strict();

function verifyGithubSignature(rawBody, signatureHeader, signingSecretEnc) {
  if (!signatureHeader || !signingSecretEnc || !rawBody) return false;
  if (!String(signatureHeader).startsWith('sha256=')) return false;

  const secret = decryptField(signingSecretEnc);
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const formatters = new Map();

export function registerWebhookFormatter(name, formatter) {
  formatters.set(name, formatter);
}

export function getWebhookFormatter(name) {
  return formatters.get(name) || null;
}

registerWebhookFormatter('generic', {
  format({ body, webhook }) {
    const parsed = genericWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        error: parsed.error.issues[0]?.message || 'Invalid webhook payload',
      };
    }
    const { text, username, attachments } = parsed.data;
    const lines = [text];
    if (attachments?.length) {
      for (const att of attachments) {
        const title = att.url ? `[${att.title}](${att.url})` : `**${att.title}**`;
        lines.push(`> ${title}: ${att.text}`);
      }
    }
    return {
      ok: true,
      senderName: username || webhook.name,
      text: lines.join('\n').slice(0, 2000),
      eventType: 'generic',
    };
  },
});

registerWebhookFormatter('github', {
  format({ body, headers, rawBody, webhook }) {
    const sig = headers['x-hub-signature-256'];
    if (!verifyGithubSignature(rawBody, sig, webhook.signingSecretEnc)) {
      return { ok: false, status: 401, error: 'Invalid GitHub webhook signature' };
    }

    const event = String(headers['x-github-event'] || 'ping').toLowerCase();
    const repo = body?.repository?.full_name || 'unknown/repo';

    if (event === 'push') {
      const branch = String(body?.ref || '').replace(/^refs\/heads\//, '') || 'unknown';
      const pusher = body?.pusher?.name || body?.sender?.login || 'someone';
      const count = Array.isArray(body?.commits) ? body.commits.length : 0;
      const headMsg = body?.commits?.[0]?.message?.split('\n')[0] || '';
      return {
        ok: true,
        senderName: webhook.name,
        eventType: 'github.push',
        text: `**[${repo}]** ${pusher} pushed ${count} commit(s) to \`${branch}\`${headMsg ? `: ${headMsg}` : ''}`.slice(
          0,
          2000
        ),
      };
    }

    if (event === 'pull_request') {
      const action = body?.action || 'updated';
      const pr = body?.pull_request;
      const num = pr?.number || body?.number || '?';
      const title = pr?.title || 'Pull request';
      const user = body?.sender?.login || 'someone';
      return {
        ok: true,
        senderName: webhook.name,
        eventType: 'github.pull_request',
        text: `**[${repo}]** PR #${num} ${action} by ${user}: ${title}`.slice(0, 2000),
      };
    }

    if (event === 'issues') {
      const action = body?.action || 'updated';
      const issue = body?.issue;
      const num = issue?.number || '?';
      const title = issue?.title || 'Issue';
      const user = body?.sender?.login || 'someone';
      return {
        ok: true,
        senderName: webhook.name,
        eventType: 'github.issues',
        text: `**[${repo}]** Issue #${num} ${action} by ${user}: ${title}`.slice(0, 2000),
      };
    }

    if (event === 'workflow_run') {
      const action = body?.action || 'completed';
      const wf = body?.workflow_run;
      const name = wf?.name || 'Workflow';
      const conclusion = wf?.conclusion || wf?.status || action;
      return {
        ok: true,
        senderName: webhook.name,
        eventType: 'github.workflow_run',
        text: `**[${repo}]** Workflow \`${name}\` ${action} (${conclusion})`.slice(0, 2000),
      };
    }

    return {
      ok: true,
      senderName: webhook.name,
      eventType: `github.${event}`,
      text: `**[${repo}]** GitHub event \`${event}\` received`.slice(0, 2000),
    };
  },
});
