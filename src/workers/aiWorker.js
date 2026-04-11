'use strict';

/**
 * AI Worker — processes BullMQ jobs from the 'ai-processing' queue.
 * Handles all AI text generation tools.
 */

require('dotenv').config();
require('../config/database').connectDB();

const { Worker } = require('bullmq');
const { redisClient } = require('../config/redis');
const Job       = require('../models/Job');
const aiService = require('../services/aiService');
const logger    = require('../utils/logger');

async function processAiJob(job) {
  const { tool, userId, inputData } = job.data;
  const startTime = Date.now();

  await Job.findOneAndUpdate(
    { jobId: job.id },
    { status: 'processing', startedAt: new Date(), progress: 20 }
  );
  await job.updateProgress(20);

  let outputData;

  try {
    switch (tool) {
      case 'summarize':
        outputData = { result: await aiService.summarize(inputData.text, inputData.options) };
        break;
      case 'translate':
        outputData = { result: await aiService.translate(inputData.text, inputData.targetLanguage, inputData.options) };
        break;
      case 'rewrite':
        outputData = { result: await aiService.rewrite(inputData.text, inputData.tone, inputData.options) };
        break;
      case 'paraphrase':
        outputData = { result: await aiService.paraphrase(inputData.text, inputData.style, inputData.options) };
        break;
      case 'grammar-check':
        outputData = { result: await aiService.grammarCheck(inputData.text, inputData.options) };
        break;
      case 'blog-writer':
        outputData = { result: await aiService.writeBlog(inputData.topic, inputData.keywords, inputData.tone, inputData.options) };
        break;
      case 'email-writer':
        outputData = { result: await aiService.writeEmail(inputData.subject, inputData.context, inputData.tone, inputData.options) };
        break;
      case 'social-caption':
        outputData = { result: await aiService.socialCaption(inputData.topic, inputData.platform, inputData.tone, inputData.options) };
        break;
      case 'headline':
        outputData = { result: await aiService.generateHeadlines(inputData.topic, inputData.count, inputData.options) };
        break;
      case 'instagram-bio':
        outputData = { result: await aiService.instagramBio(inputData.name, inputData.niche, inputData.mood, inputData.options) };
        break;
      case 'description':
        outputData = { result: await aiService.writeDescription(inputData.title, inputData.features, inputData.audience, inputData.tone, inputData.options) };
        break;
      case 'script-writer':
        outputData = { result: await aiService.writeScript(inputData.topic, inputData.scriptType, inputData.keyPoints, inputData.tone, inputData.options) };
        break;
      default:
        outputData = { result: await aiService.generic(tool, inputData) };
    }

    await job.updateProgress(100);
    const processingTime = Date.now() - startTime;

    await Job.findOneAndUpdate(
      { jobId: job.id },
      { status: 'completed', progress: 100, outputData, completedAt: new Date(), processingTime }
    );

    logger.info('AI job completed', { jobId: job.id, tool, processingTime });
    return outputData;

  } catch (err) {
    await Job.findOneAndUpdate(
      { jobId: job.id },
      { status: 'failed', error: err.message, completedAt: new Date() }
    );
    throw err;
  }
}

const worker = new Worker('ai-processing', processAiJob, {
  connection: redisClient,
  concurrency: 10,  // AI API calls are async / non-blocking
});

worker.on('completed', (job) => logger.info('AI job done', { jobId: job.id }));
worker.on('failed', (job, err) => logger.error('AI job failed', { jobId: job?.id, error: err.message }));
worker.on('error', (err) => logger.error('AI worker error', { error: err.message }));

logger.info('AI worker started — listening on queue: ai-processing');

module.exports = worker;
