/**
 * Redis client module (ioredis).
 *
 * Creates and exports a single shared ioredis client.  ioredis handles
 * automatic reconnection internally; we just wire up event listeners so the
 * logger captures important state changes.
 *
 * The client is lazy-connected – it does not attempt to connect until the
 * first command or until .connect() is called explicitly.
 */

const Redis = require('ioredis');
const logger = require('../utils/logger');
const { REDIS_URL } = require('./index');

/**
 * ioredis client configured from REDIS_URL.
 *
 * lazyConnect: true means the connection is deferred until the first command.
 * This prevents the process from crashing at import time when Redis isn't yet
 * reachable (e.g. during early startup before connectDB resolves).
 *
 * @type {import('ioredis').Redis}
 */
const redisClient = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null, // required by BullMQ
  enableOfflineQueue: false,  // reject commands immediately when disconnected
  retryStrategy(times) {
    // If we hit a rate limit or quota error, stop retrying immediately.
    if (redisClient._lastError) {
      const msg = redisClient._lastError;
      if (
        msg.includes('max requests limit exceeded') ||
        msg.includes('ERR max')
      ) {
        logger.error('Redis quota exceeded — disabling retries.');
        return null; // null = stop retrying
      }
    }
    if (times > 10) {
      logger.error('Redis max retries reached — giving up.');
      return null;
    }
    // Exponential back-off capped at 10 seconds.
    const delay = Math.min(times * 500, 10000);
    logger.warn(`Redis retry attempt #${times}. Retrying in ${delay}ms…`);
    return delay;
  },
});

// ─── Connection event listeners ──────────────────────────────────────────────

redisClient.on('connect', () => {
  logger.info('Redis client connected.');
});

redisClient.on('ready', () => {
  logger.info('Redis client ready to accept commands.');
});

redisClient.on('error', (err) => {
  // Store last error message for retryStrategy to check.
  redisClient._lastError = err.message;
  logger.error(`Redis client error: ${err.message}`);
});

redisClient.on('reconnecting', (delay) => {
  logger.warn(`Redis client reconnecting in ${delay}ms…`);
});

redisClient.on('end', () => {
  logger.warn('Redis client connection closed.');
});

module.exports = { redisClient };
