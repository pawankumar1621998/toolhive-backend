'use strict';

/**
 * Cron: Subscription expiry checker.
 * Runs daily at 1:00 AM — checks for expired subscriptions and downgrades users.
 * Also sends 3-day expiry warning emails.
 */

const cron         = require('node-cron');
const Subscription = require('../models/Subscription');
const User         = require('../models/User');
const emailService = require('../services/emailService');
const logger       = require('../utils/logger');

/**
 * Check and expire subscriptions:
 * 1. Find subscriptions expiring in ~3 days → send warning email.
 * 2. Find subscriptions that have already expired → downgrade to free.
 */
async function checkSubscriptions() {
  logger.info('Running subscription expiry check...');

  const now          = new Date();
  const threeDaysOut = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  try {
    // ── 1. Send 3-day expiry warnings ────────────────────────────────────────

    const expiringSoon = await Subscription.find({
      status:  'active',
      plan:    { $in: ['pro', 'premium'] },
      endDate: { $gte: now, $lte: threeDaysOut },
    }).populate('userId', 'email name');

    for (const sub of expiringSoon) {
      if (!sub.userId) continue;
      try {
        await emailService.sendExpiryWarning(sub.userId, sub);
        logger.info('Expiry warning sent', { userId: sub.userId._id, endDate: sub.endDate });
      } catch (err) {
        logger.warn('Expiry warning email failed', { error: err.message });
      }
    }

    // ── 2. Downgrade expired subscriptions ───────────────────────────────────

    const expired = await Subscription.find({
      status:  { $in: ['active', 'cancelled'] },
      plan:    { $in: ['pro', 'premium'] },
      endDate: { $lt: now },
    });

    let downgradeCount = 0;

    for (const sub of expired) {
      sub.status = 'expired';
      sub.plan   = 'free';
      await sub.save();

      await User.findByIdAndUpdate(sub.userId, { plan: 'free' });
      downgradeCount++;
    }

    logger.info('Subscription expiry check complete', {
      warningsSent:  expiringSoon.length,
      downgraded:    downgradeCount,
    });

  } catch (err) {
    logger.error('Subscription expiry cron failed', { error: err.message });
  }
}

// Schedule: every day at 01:00 AM
function startSubscriptionExpiryJob() {
  cron.schedule('0 1 * * *', checkSubscriptions, {
    timezone: 'Asia/Kolkata',
  });
  logger.info('Subscription expiry cron scheduled (daily 01:00 IST)');
}

module.exports = { startSubscriptionExpiryJob, checkSubscriptions };
