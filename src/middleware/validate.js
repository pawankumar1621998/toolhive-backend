'use strict';

/**
 * Joi-based request validation middleware.
 *
 * Usage:
 *   router.post('/signup', validate(signupSchema), authController.signup);
 *   router.get('/search', validateQuery(searchSchema), toolController.search);
 */

const Joi = require('joi');

// ─── Core factory ─────────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that validates req[property] against a Joi schema.
 *
 * @param {Joi.ObjectSchema} schema   - Joi schema to validate against.
 * @param {'body'|'query'|'params'}  [property='body'] - Which part of the request to validate.
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,      // Collect all errors, not just the first
      allowUnknown: false,    // Reject unknown fields
      stripUnknown: true,     // Remove unknown fields from the value
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message.replace(/['"]/g, ''),
      }));

      return res.status(400).json({
        success: false,
        statusCode: 400,
        message: 'Validation failed',
        errors,
      });
    }

    // Replace the original value with the stripped/coerced Joi value
    req[property] = value;
    next();
  };
};

// ─── Convenience shorthands ──────────────────────────────────────────────────

/** Validate req.query */
const validateQuery = (schema) => validate(schema, 'query');

/** Validate req.params */
const validateParams = (schema) => validate(schema, 'params');

// ─── Common reusable schemas ──────────────────────────────────────────────────

const schemas = {
  objectId: Joi.string().hex().length(24).required(),

  pagination: Joi.object({
    page:  Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),

  /** Auth */
  signup: Joi.object({
    name:     Joi.string().trim().min(2).max(50).required(),
    email:    Joi.string().email().lowercase().trim().required(),
    password: Joi.string().min(8).max(128).required(),
  }),

  login: Joi.object({
    email:    Joi.string().email().lowercase().trim().required(),
    password: Joi.string().required(),
  }),

  forgotPassword: Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
  }),

  resetPassword: Joi.object({
    token:    Joi.string().required(),
    password: Joi.string().min(8).max(128).required(),
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword:     Joi.string().min(8).max(128).required(),
  }),

  /** Profile */
  updateProfile: Joi.object({
    name:   Joi.string().trim().min(2).max(50),
    avatar: Joi.string().uri(),
  }),

  /** Tools */
  aiText: Joi.object({
    text:     Joi.string().min(1).max(10000).required(),
    language: Joi.string().max(20).default('en'),
    tone:     Joi.string().max(30),
    style:    Joi.string().max(30),
    options:  Joi.object(),
  }),

  /** Payments */
  createOrder: Joi.object({
    plan:     Joi.string().valid('pro', 'premium').required(),
    duration: Joi.number().integer().min(1).max(12).default(1),
    gateway:  Joi.string().valid('razorpay', 'stripe').required(),
  }),

  verifyPayment: Joi.object({
    orderId:   Joi.string().required(),
    paymentId: Joi.string().required(),
    signature: Joi.string(),  // Razorpay signature
  }),
};

module.exports = { validate, validateQuery, validateParams, schemas };
