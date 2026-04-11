/**
 * Application entry point.
 *
 * Responsibilities:
 *  - Load environment variables from .env
 *  - Connect to MongoDB and Redis before accepting traffic
 *  - Start the HTTP server
 *  - Perform a graceful shutdown on SIGTERM / SIGINT so in-flight requests
 *    finish and connections are closed cleanly (important for container
 *    orchestrators like Kubernetes / Docker).
 *  - Catch unhandledRejection and uncaughtException so the process never
 *    silently continues in a corrupt state.
 */

'use strict';

// Must be first – loads .env before any other module reads process.env.
require('dotenv').config();

const http = require('http');

const app = require('./src/app');
const { connectDB } = require('./src/config/database');
const { redisClient } = require('./src/config/redis');
const logger = require('./src/utils/logger');
const { PORT } = require('./src/config/index');
const { startSubscriptionExpiryJob } = require('./src/cron/subscriptionExpiry');
const { startUsageResetJob }         = require('./src/cron/usageReset');

// ─── Unhandled error safety net ───────────────────────────────────────────────

/**
 * Catch Promise rejections that were never handled with .catch().
 * Log the reason and exit – running with an uncaught rejection is unsafe.
 */
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise,
  });
  // Give the logger time to flush, then exit with failure code.
  process.exit(1);
});

/**
 * Catch synchronous exceptions that escaped all try/catch blocks.
 * The process must exit immediately – the heap may be in an inconsistent state.
 */
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Initialise all infrastructure, then start the HTTP server.
 * Throwing here (or inside a dependency) will be caught by unhandledRejection.
 */
const startServer = async () => {
  // 1. Connect to MongoDB (retry up to 5 times with 3 s delay).
  let dbConnected = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await connectDB();
      dbConnected = true;
      break;
    } catch (err) {
      logger.warn(`MongoDB connect attempt ${attempt}/5 failed: ${err.message}`);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!dbConnected) {
    logger.error('Could not connect to MongoDB after 5 attempts. Exiting.');
    process.exit(1);
  }

  // 2. Connect to Redis if not already connected (BullMQ may have connected it
  // earlier when queues.js was imported). Redis is optional in development.
  if (redisClient.status === 'wait') {
    try {
      await redisClient.connect();
    } catch (err) {
      logger.warn(`Redis unavailable: ${err.message}. Continuing without Redis (job queues disabled).`);
    }
  }

  // 3. Create the HTTP server from the Express app.
  const server = http.createServer(app);

  // 4. Start cron jobs (only in main process, not workers).
  startSubscriptionExpiryJob();
  startUsageResetJob();

  // 5. Start listening.
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────────

  /**
   * Gracefully close the server and all connections.
   *
   * @param {string} signal - The OS signal that triggered the shutdown.
   */
  const shutdown = async (signal) => {
    logger.info(`${signal} received. Starting graceful shutdown…`);

    // Stop accepting new connections; wait for in-flight requests to finish.
    server.close(async () => {
      try {
        // Close MongoDB connection pool.
        const mongoose = require('mongoose');
        await mongoose.connection.close();
        logger.info('MongoDB connection closed.');

        // Disconnect Redis client.
        await redisClient.quit();
        logger.info('Redis connection closed.');

        logger.info('Graceful shutdown complete. Exiting.');
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
      }
    });

    // Force-kill if graceful shutdown takes more than 15 seconds.
    setTimeout(() => {
      logger.error('Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 15_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer();
