import mongoose from 'mongoose';
import env from '../config/env.js';
import FeatureFlag from '../models/FeatureFlag.js';
import { AppError } from '../middleware/errorHandler.js';

export const FLAG_NAMES = [
  'scheduledMessages',
  'polls',
  'uploads',
  'aiSummaries',
  'workspaces',
  'onboarding',
  'slashCommands',
  'bots',
  'incomingWebhooks',
  'outgoingWebhooks',
];

const CACHE_TTL_MS = 5000;
let cachedFlags = null;
let cacheExpiresAt = 0;

function getEnvDefaults() {
  return {
    scheduledMessages: env.FLAG_SCHEDULED_MESSAGES !== 'false',
    polls: env.FLAG_POLLS !== 'false',
    uploads: env.FLAG_UPLOADS !== 'false',
    aiSummaries: env.FLAG_AI_SUMMARIES !== 'false',
    workspaces:
      env.NODE_ENV === 'production'
        ? process.env.FLAG_WORKSPACES === 'true'
        : process.env.FLAG_WORKSPACES !== 'false',
    onboarding:
      env.NODE_ENV === 'production'
        ? process.env.FLAG_ONBOARDING === 'true'
        : process.env.FLAG_ONBOARDING !== 'false',
    slashCommands:
      env.NODE_ENV === 'production'
        ? process.env.FLAG_SLASH_COMMANDS === 'true'
        : process.env.FLAG_SLASH_COMMANDS !== 'false',
    bots:
      env.NODE_ENV === 'production'
        ? process.env.FLAG_BOTS === 'true'
        : process.env.FLAG_BOTS !== 'false',
    incomingWebhooks:
      env.NODE_ENV === 'production'
        ? process.env.FLAG_INCOMING_WEBHOOKS === 'true'
        : process.env.FLAG_INCOMING_WEBHOOKS !== 'false',
    outgoingWebhooks:
      env.NODE_ENV === 'production'
        ? process.env.FLAG_OUTGOING_WEBHOOKS === 'true'
        : process.env.FLAG_OUTGOING_WEBHOOKS !== 'false',
  };
}

export async function getFlags({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && cachedFlags && now < cacheExpiresAt) {
    return { ...cachedFlags };
  }

  const flags = getEnvDefaults();
  if (mongoose.connection.readyState === 1) {
    const overrides = await FeatureFlag.find({}).lean();
    for (const row of overrides) {
      if (row.name in flags) {
        flags[row.name] = Boolean(row.enabled);
      }
    }
  }

  cachedFlags = flags;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return { ...flags };
}

export async function setFlag(name, enabled, userId = null) {
  if (!FLAG_NAMES.includes(name)) {
    throw new AppError(`Unknown feature flag: ${name}`, 400);
  }
  await FeatureFlag.updateOne(
    { name },
    { $set: { enabled: Boolean(enabled), updatedBy: userId } },
    { upsert: true }
  );
  cachedFlags = null;
  cacheExpiresAt = 0;
  return getFlags({ bypassCache: true });
}

export function invalidateFlagCache() {
  cachedFlags = null;
  cacheExpiresAt = 0;
}

export async function isFeatureEnabled(name) {
  const flags = await getFlags();
  return Boolean(flags[name]);
}

export function requireFeature(name) {
  return async (_req, _res, next) => {
    try {
      const enabled = await isFeatureEnabled(name);
      if (!enabled) {
        return next(new AppError(`Feature "${name}" is currently disabled`, 403));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
