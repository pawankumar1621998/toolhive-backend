'use strict';

const rateLimit = require('express-rate-limit');

// ─── Optional Redis store factory ────────────────────────────────────────────
// express-rate-limit requires a SEPARATE store instance per limiter (each with
// a unique prefix).  We build a factory so each call returns a fresh instance.
// If Redis is unavailable we return undefined and fall back to memory store.

let makeStore;

if (process.env.REDIS_URL) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const Redis = require('ioredis');

    // Dedicated Redis client for rate limiting.
    // enableOfflineQueue: true  → commands queue while connecting (default).
    // enableReadyCheck: false   → required for Upstash.
    const redisClient = new Redis(process.env.REDIS_URL, {
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });

    redisClient.on('error', (err) => {
      // Don't crash on transient Redis errors – rate limiting falls back
      // to in-memory automatically when commands fail.
      console.warn('[rateLimiter] Redis error:', err.message);
    });

    // Factory: each call creates a store with its own prefix.
    makeStore = (prefix) =>
      new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
        prefix: `rl:${prefix}:`,
      });
  } catch (err) {
    console.warn(
      '[rateLimiter] Redis store unavailable, falling back to memory store:',
      err.message
    );
    makeStore = null;
  }
}

// ─── Shared base options ──────────────────────────────────────────────────────

const baseOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json({
      success: false,
      message: options.message,
      retryAfter: Math.ceil(options.windowMs / 1000 / 60),
    });
  },
};

// ─── Limiter factory ──────────────────────────────────────────────────────────

function createLimiter(prefix, overrides) {
  return rateLimit({
    ...baseOptions,
    ...(makeStore ? { store: makeStore(prefix) } : {}),
    ...overrides,
  });
}

// ─── Limiters ─────────────────────────────────────────────────────────────────

const generalLimiter = createLimiter('general', {
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again in 15 minutes.',
});

const authLimiter = createLimiter('auth', {
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts, please try again in 15 minutes.',
  skipSuccessfulRequests: true,
});

const uploadLimiter = createLimiter('upload', {
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Upload limit reached. You can upload up to 20 files per hour.',
});

const apiLimiter = createLimiter('api', {
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'API rate limit exceeded, please try again in 15 minutes.',
});

module.exports = { generalLimiter, authLimiter, uploadLimiter, apiLimiter };
