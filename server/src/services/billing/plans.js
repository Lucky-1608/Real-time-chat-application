import { AppError } from '../../middleware/errorHandler.js';

export const PLAN_LIMITS = {
  free: {
    members: 10,
    bots: 2,
    webhooks: 2,
    retentionDays: 30,
  },
  pro: {
    members: 100,
    bots: 10,
    webhooks: 20,
    retentionDays: 365,
  },
  team: {
    members: 1000,
    bots: 50,
    webhooks: 100,
    retentionDays: 3650,
  },
};

export function getPlanLimits(plan = 'free') {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

export function assertWorkspaceQuota(workspace, resourceType, currentCount) {
  const limits = getPlanLimits(workspace?.plan || 'free');
  const max = limits[resourceType];
  if (typeof max === 'number' && currentCount >= max) {
    throw new AppError(
      `Workspace "${workspace?.plan || 'free'}" plan quota reached for ${resourceType} (limit: ${max})`,
      402
    );
  }
}
