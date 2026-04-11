'use strict';

/**
 * Cron: Usage reset.
 * Daily at midnight — clears Redis usage cache (DB records are date-based, auto-reset).
 * Monthly on 1st — could archive old usage records.
 */

const cron         = require('node-cron');
const usageService = require('../services/usageService');
const Usage        = require('../models/Usage');
const logger       = require('../utils/logger');

/** Clear Redis daily usage cache at midnight */
async function resetDailyUsage() {
  logger.info('Running daily usage cache reset...');
  try {
    await usageService.resetDailyCache();
    logger.info('Daily usage cache reset complete');
  } catch (err) {
    logger.error('Daily usage reset failed', { error: err.message });
  }
}

/** Archive usage records older than 90 days (runs monthly) */
async function archiveOldUsage() {
  logger.info('Running monthly usage archive...');
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const result = await Usage.deleteMany({ date: { $lt: ninetyDaysAgo } });
    logger.info('Usage archive complete', { deleted: result.deletedCount });
  } catch (err) {
    logger.error('Usage archive failed', { error: err.message });
  }
}

function startUsageResetJob() {
  // Daily at midnight
  cron.schedule('0 0 * * *', resetDailyUsage, { timezone: 'Asia/Kolkata' });

  // Monthly on 1st at 2 AM
  cron.schedule('0 2 1 * *', archiveOldUsage, { timezone: 'Asia/Kolkata' });

  logger.info('Usage reset crons scheduled');
}

module.exports = { startUsageResetJob, resetDailyUsage };
