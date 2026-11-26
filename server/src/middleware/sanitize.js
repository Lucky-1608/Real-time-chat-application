function stripUnsafeKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripUnsafeKeys);
  }
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) {
        continue;
      }
      clean[k] = stripUnsafeKeys(v);
    }
    return clean;
  }
  return value;
}

/**
 * Strips MongoDB operator keys ($gt, $ne, etc.) and dotted keys from
 * req.body, req.query, and req.params before Zod validation and Mongoose queries.
 */
export function sanitizeNoSql(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = stripUnsafeKeys(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = stripUnsafeKeys(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = stripUnsafeKeys(req.params);
  }
  next();
}
