export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    // Distinguishes expected client/domain errors from unexpected programmer bugs.
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

export function errorHandler(err, _req, res, _next) {
  let statusCode = err.statusCode || 500;
  let message = err.isOperational ? err.message : 'Internal server error';

  if (err.name === 'ZodError') {
    statusCode = 400;
    message = err.issues?.[0]?.message || 'Validation error';
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid identifier format';
  } else if (err.code === 11000) {
    statusCode = 409;
    message = 'Resource already exists';
  }

  if (!err.isOperational && statusCode === 500) {
    console.error('[errorHandler] Unexpected error:', err);
  }

  res.status(statusCode).json({ error: message });
}
