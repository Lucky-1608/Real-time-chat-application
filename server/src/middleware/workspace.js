import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import { ensureDefaultWorkspace } from '../services/workspaceMigration.js';
import { AppError } from './errorHandler.js';

/**
 * Resolves the active workspace from X-Workspace-Id header (or falls back to
 * the Default workspace for backward-compatible single-workspace clients),
 * and verifies that the authenticated user is an active member.
 */
export async function resolveWorkspace(req, _res, next) {
  try {
    const headerId = req.headers['x-workspace-id'] || req.query?.workspaceId;
    let workspace;

    if (headerId) {
      if (!mongoose.isValidObjectId(String(headerId))) {
        return next(new AppError('Invalid workspace ID', 400));
      }
      workspace = await Workspace.findById(headerId).lean();
      if (!workspace) {
        return next(new AppError('Workspace not found', 404));
      }
    } else {
      const res = await ensureDefaultWorkspace(req.user?.id);
      workspace = res.workspace.toObject ? res.workspace.toObject() : res.workspace;
    }

    if (req.user?.id) {
      let membership = await WorkspaceMember.findOne({
        workspace: workspace._id,
        user: req.user.id,
        status: 'active',
      }).lean();

      // Auto-enroll on the Default workspace if no explicit header was passed
      // (keeps legacy tests that seed users directly working seamlessly).
      if (!membership && !headerId && workspace.slug === 'default') {
        membership = await WorkspaceMember.create({
          workspace: workspace._id,
          user: req.user.id,
          role: req.user.globalRole === 'admin' ? 'admin' : 'member',
          status: 'active',
        });
      }

      if (!membership) {
        return next(new AppError('You are not a member of this workspace', 403));
      }
      req.workspaceMember = membership;
    }

    req.workspace = workspace;
    req.workspaceId = workspace._id.toString();
    return next();
  } catch (err) {
    return next(err);
  }
}
