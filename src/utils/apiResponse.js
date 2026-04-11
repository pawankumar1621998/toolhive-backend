/**
 * Standardised API response utilities.
 *
 * All HTTP responses produced by the application should go through the helpers
 * defined here so the client always receives a consistent JSON envelope:
 *
 *   Success: { success: true,  statusCode, message, data }
 *   Error:   { success: false, statusCode, message, errors }
 */

// ─── Classes ─────────────────────────────────────────────────────────────────

/**
 * Represents a successful API response payload.
 *
 * @class ApiResponse
 */
class ApiResponse {
  /**
   * @param {number} statusCode - HTTP status code (2xx).
   * @param {*}      data       - Response payload (object, array, etc.).
   * @param {string} [message]  - Human-readable success message.
   */
  constructor(statusCode, data, message = 'Success') {
    this.success = true;
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
  }
}

/**
 * Represents an operational (expected) API error.
 * Extends the native Error so it can be thrown and caught by Express error
 * handlers or the express-async-errors middleware.
 *
 * @class ApiError
 * @extends {Error}
 */
class ApiError extends Error {
  /**
   * @param {number}   statusCode - HTTP status code (4xx / 5xx).
   * @param {string}   message    - Human-readable error message.
   * @param {Array}    [errors]   - Optional array of field-level error objects.
   */
  constructor(statusCode, message, errors = []) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;

    // Capture a clean stack trace that excludes this constructor frame.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }
}

// ─── Response helpers ────────────────────────────────────────────────────────

/**
 * Send a standardised success response.
 *
 * @param {import('express').Response} res        - Express response object.
 * @param {*}                          data        - Payload to include in `data`.
 * @param {string}                     [message]   - Success message.
 * @param {number}                     [statusCode=200] - HTTP status code.
 * @returns {import('express').Response}
 */
const successResponse = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json(new ApiResponse(statusCode, data, message));
};

/**
 * Send a standardised error response.
 *
 * @param {import('express').Response} res          - Express response object.
 * @param {string}                     message      - Error message.
 * @param {number}                     [statusCode=400] - HTTP status code.
 * @param {Array}                      [errors=[]]  - Field-level error details.
 * @returns {import('express').Response}
 */
const errorResponse = (res, message, statusCode = 400, errors = []) => {
  return res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    errors,
  });
};

module.exports = { ApiResponse, ApiError, successResponse, errorResponse };
