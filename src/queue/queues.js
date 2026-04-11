'use strict';

/**
 * BullMQ Queue definitions.
 *
 * All queues are defined here and imported by workers + controllers.
 * Using a single Redis connection shared across queues.
 */

const { Queue } = require('bullmq');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

// ─── Shared connection config ─────────────────────────────────────────────────
// BullMQ requires maxRetriesPerRequest: null on the Redis connection.

const connection = redisClient;

// ─── Queue options ────────────────────────────────────────────────────────────

const DEFAULT_JOB_OPTIONS = {
  attempts:  3,
  backoff: {
    type:  'exponential',
    delay: 2000,   // 2s, 4s, 8s
  },
  removeOnComplete: { age: 3600, count: 500 },   // keep 1h or 500 entries
  removeOnFail:     { age: 86400 },              // keep failures for 24h
};

// ─── Queue instances ─────────────────────────────────────────────────────────

/**
 * PDF processing jobs: compress, merge, split, convert, OCR, etc.
 */
// Shared queue settings — skipVersionCheck suppresses Upstash eviction policy warnings.
const QUEUE_SETTINGS = { skipVersionCheck: true };

const pdfQueue = new Queue('pdf-processing', {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
  settings: QUEUE_SETTINGS,
});

/**
 * Image processing jobs: resize, compress, bg-remove, format-convert, etc.
 */
const imageQueue = new Queue('image-processing', {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
  settings: QUEUE_SETTINGS,
});

/**
 * AI text generation jobs: summarize, translate, rewrite, etc.
 * Separated from file queues because AI jobs are CPU-light but API-rate-limited.
 */
const aiQueue = new Queue('ai-processing', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 2,
  },
  settings: QUEUE_SETTINGS,
});

/**
 * Video/audio processing jobs (heavy — separate worker process).
 */
const mediaQueue = new Queue('media-processing', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 2,
  },
  settings: QUEUE_SETTINGS,
});

/**
 * Email notification jobs — low priority, high reliability.
 */
const emailQueue = new Queue('email', {
  connection,
  defaultJobOptions: {
    attempts:  5,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: true,
    removeOnFail:     { age: 86400 },
  },
  settings: QUEUE_SETTINGS,
});

// ─── Queue event logging ─────────────────────────────────────────────────────

[pdfQueue, imageQueue, aiQueue, mediaQueue, emailQueue].forEach((q) => {
  q.on('error', (err) => logger.error(`Queue [${q.name}] error`, { error: err.message }));
});

// ─── Helper: add a job and return its ID ─────────────────────────────────────

/**
 * Add a job to the appropriate queue based on job category.
 *
 * @param {string} category   - 'pdf' | 'image' | 'ai' | 'media' | 'email'
 * @param {string} jobName    - Human-readable job name / tool slug.
 * @param {object} data       - Job payload.
 * @param {object} [opts]     - Override default job options.
 * @returns {Promise<import('bullmq').Job>}
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

  const job = await queue.add(jobName, data, opts);
  logger.info('Job queued', { queue: queue.name, jobId: job.id, jobName });
  return job;
}

module.exports = { pdfQueue, imageQueue, aiQueue, mediaQueue, emailQueue, addJob };
