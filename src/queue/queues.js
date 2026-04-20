'use strict';

/**
 * BullMQ Queue definitions.
 *
 * All queues are optional — if Redis is unavailable (quota exceeded,
 * connection refused, etc.) the module still loads and addJob() resolves
 * with null so the rest of the app keeps running.
 */

const { Queue } = require('bullmq');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

// ─── Shared connection config ─────────────────────────────────────────────────

const connection = redisClient;

// ─── Queue options ────────────────────────────────────────────────────────────

const DEFAULT_JOB_OPTIONS = {
  attempts:  3,
  backoff: {
    type:  'exponential',
    delay: 2000,
  },
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail:     { age: 86400 },
};

const QUEUE_SETTINGS = { skipVersionCheck: true };

// ─── Safe queue factory ───────────────────────────────────────────────────────
// Returns null if BullMQ throws during construction (e.g. Redis unavailable).

function createQueue(name, opts = {}) {
  try {
    const q = new Queue(name, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
      settings: QUEUE_SETTINGS,
      ...opts,
    });

    q.on('error', (err) => {
      logger.error(`Queue [${q.name}] error`, { error: err.message });
      // Absorb the error — prevent it becoming an unhandled rejection.
    });

    // Absorb any internal BullMQ promise rejections on this queue.
    q.waitUntilReady().catch((err) => {
      logger.warn(`Queue [${name}] not ready: ${err.message}`);
    });

    return q;
  } catch (err) {
    logger.warn(`Queue [${name}] could not be created: ${err.message}`);
    return null;
  }
}

// ─── Queue instances ─────────────────────────────────────────────────────────

const pdfQueue   = createQueue('pdf-processing');
const imageQueue = createQueue('image-processing');
const aiQueue    = createQueue('ai-processing', {
  defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 2 },
});
const mediaQueue = createQueue('media-processing', {
  defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 2 },
});
const emailQueue = createQueue('email', {
  defaultJobOptions: {
    attempts:  5,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { age: 86400 },
  },
});

// ─── Helper: add a job ────────────────────────────────────────────────────────

/**
 * Add a job to the appropriate queue.
 * Returns the BullMQ Job object, or null if the queue is unavailable.
 */
async function addJob(category, jobName, data, opts = {}) {
  let queue;
  switch (category) {
    case 'pdf':   queue = pdfQueue;   break;
    case 'image': queue = imageQueue; break;
    case 'ai':    queue = aiQueue;    break;
    case 'email': queue = emailQueue; break;
    default:      queue = mediaQueue;
  }

  if (!queue) {
    logger.warn(`addJob: queue for category '${category}' is unavailable (Redis down?)`);
    return null;
  }

  try {
    const job = await queue.add(jobName, data, opts);
    logger.info('Job queued', { queue: queue.name, jobId: job.id, jobName });
    return job;
  } catch (err) {
    logger.error('addJob failed', { category, jobName, error: err.message });
    return null;
  }
}

module.exports = { pdfQueue, imageQueue, aiQueue, mediaQueue, emailQueue, addJob };
