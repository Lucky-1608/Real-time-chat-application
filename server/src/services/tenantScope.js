const SCOPED_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'countDocuments',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
];

/**
 * Mongoose plugin that enforces tenant isolation by requiring `workspace` in
 * every query filter on tenant-scoped models unless `{ bypassTenantScope: true }`
 * is explicitly passed for system migrations or background sweepers.
 */
export function tenantPlugin(schema) {
  for (const op of SCOPED_OPS) {
    schema.pre(op, function enforceTenantScope(next) {
      const opts = this.getOptions ? this.getOptions() : {};
      if (opts?.bypassTenantScope === true) {
        return next();
      }
      const filter = this.getFilter ? this.getFilter() : {};
      // Allow empty deleteMany({}) only in test cleanup hooks.
      if (
        op === 'deleteMany' &&
        process.env.NODE_ENV === 'test' &&
        Object.keys(filter || {}).length === 0
      ) {
        return next();
      }
      if (!filter || !filter.workspace) {
        return next(
          new Error(
            `Tenant isolation violation: ${op} on ${this.model?.modelName || 'tenant model'} missing workspace filter`
          )
        );
      }
      return next();
    });
  }
}

/**
 * Returns a workspace-scoped repository wrapper around a Mongoose model so
 * tenant filters cannot be omitted by callers.
 */
export function scopedRepo(Model, workspaceId) {
  if (!workspaceId) {
    throw new Error('scopedRepo requires a workspaceId');
  }
  return {
    find(filter = {}, projection = null, options = {}) {
      return Model.find({ ...filter, workspace: workspaceId }, projection, options);
    },
    findOne(filter = {}, projection = null, options = {}) {
      return Model.findOne({ ...filter, workspace: workspaceId }, projection, options);
    },
    countDocuments(filter = {}) {
      return Model.countDocuments({ ...filter, workspace: workspaceId });
    },
    create(doc) {
      return Model.create({ ...doc, workspace: workspaceId });
    },
    updateOne(filter = {}, update = {}, options = {}) {
      return Model.updateOne({ ...filter, workspace: workspaceId }, update, options);
    },
    findOneAndUpdate(filter = {}, update = {}, options = {}) {
      return Model.findOneAndUpdate({ ...filter, workspace: workspaceId }, update, options);
    },
  };
}
