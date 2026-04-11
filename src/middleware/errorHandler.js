'use strict';

/**
 * Global Express error-handling middleware.
 *
 * Must be registered LAST in app.js (after all routes). Express identifies
 * error handlers by their 4-argument signature (err, req, res, next).
 *
 * Error catalogue:
 *  1. Mongoose ValidationError  → 400 with per-field details
 *  2. Mongoose CastError        → 400 "Invalid ID"
 *  3. MongoDB duplicate key     → 409 "Already exists"
 *  4. JWT errors                → 401
 *  5. Multer errors             → 400
 *  6. ApiError (operational)    → use the error's own statusCode
 *  7. Everything else           → 500
 *
 * In development the response includes the full stack trace.
 */

const mongoose = require('mongoose');
const { ApiError, errorResponse } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// ─── Multer error codes and their human-readable messages ─────────────────────
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'File is too large',
  LIMIT_FILE_COUNT: 'Too many files uploaded',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
  LIMIT_PART_COUNT: 'Too many parts in the multipart request',
  LIMIT_FIELD_KEY: 'Field name is too long',
  LIMIT_FIELD_VALUE: 'Field value is too long',
  LIMIT_FIELD_COUNT: 'Too many fields',
};

/**
 * Normalise a Mongoose ValidationError into a flat array of field messages.
 * @param {import('mongoose').Error.ValidationError} err
 * @returns {{ field: string, message: string }[]}
 */
const extractValidationErrors = (err) =>
  Object.values(err.errors).map((e) => ({
    field: e.path,
    message: e.message,
  }));

/**
 * Central error handler – attached to Express as a 4-arity middleware.
 *
 * @param {Error}                          err
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next  – Must be declared even if unused.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // ── Log every error ────────────────────────────────────────────────────────
  // Operational (ApiError) → warn; unexpected → error
  const logMeta = {
    path: req.originalUrl || req.path,
    method: req.method,
    userId: req.user && req.user._id,
  };

  if (err.isOperational) {
    logger.warn(`[${req.method}] ${req.originalUrl} — ${err.message}`, {
      ...logMeta,
      statusCode: err.statusCode,
    });
  } else {
    logger.error(`${err.name || 'Error'}: ${err.message}`, {
      ...logMeta,
      stack: err.stack,
    });
  }

  // ── Default error shape ────────────────────────────────────────────────────
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let errors = [];

  // ── 1. Mongoose ValidationError ───────────────────────────────────────────
  if (err instanceof mongoose.Error.ValidationError || err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation failed';
    errors = extractValidationErrors(err);
  }

  // ── 2. Mongoose CastError (invalid ObjectId or type coercion) ─────────────
  else if (err instanceof mongoose.Error.CastError || err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid ID';
    errors = [];
  }

  // ── 3. MongoDB duplicate key (unique index violation, code 11000) ──────────
  else if (err.code === 11000) {
    statusCode = 409;
    const field = err.keyValue ? Object.keys(err.keyValue).join(', ') : 'field';
    message = `${field} already exists`;
    errors = [];
  }

  // ── 4. JWT errors ──────────────────────────────────────────────────────────
  else if (
    err.name === 'JsonWebTokenError' ||
    err.name === 'TokenExpiredError' ||
    err.name === 'NotBeforeError'
  ) {
    statusCode = 401;
    message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    errors = [];
  }

  // ── 5. Multer errors ───────────────────────────────────────────────────────
  else if (err.name === 'MulterError') {
    statusCode = 400;
    message = MULTER_MESSAGES[err.code] || `Upload error: ${err.message}`;
    errors = [];
  }

  // ── 6. Custom ApiError (operational, intentionally thrown) ────────────────
  else if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    errors = err.errors || [];
  }

  // ── 7. Fall-through: unexpected / programmer error ─────────────────────────
  else if (!err.isOperational) {
    statusCode = 500;
    message =
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message || 'Internal server error';
  }

  // ── Build response ─────────────────────────────────────────────────────────
  const responseBody = {
    success: false,
    statusCode,
    message,
    ...(errors.length > 0 ? { errors } : {}),
  };

  // Expose stack trace only in development so internals don't leak to clients
  if (process.env.NODE_ENV === 'development' && err.stack) {
    responseBody.stack = err.stack;
  }

  return res.status(statusCode).json(responseBody);
};

// Export both as named and default for backward-compatibility
module.exports = errorHandler;
module.exports.errorHandler = errorHandler;
