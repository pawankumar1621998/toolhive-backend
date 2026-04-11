'use strict';

/**
 * Usage Service — track and enforce per-user tool usage limits.
 */

const Usage = require('../models/Usage');
const Subscription = require('../models/Subscription');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

// ─── Plan limits (must match Subscription model) ─────────────────────────────

const PLAN_LIMITS = {
  free:    { daily: 50,  monthly: 500  },
  pro:     { daily: 100, monthly: 1000 },
  premium: { daily: -1,  monthly: -1   }, // -1 = unlimited
};

const usageService = {

  /**
   * Get today's usage count for a user (Redis-cached for performance).
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  getTodayUsage: async (userId) => {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const cacheKey = `usage:daily:${userId}:${today}`;

    try {
      // Try Redis cache first
      const cached = await redisClient.get(cacheKey);
      if (cached !== null) return parseInt(cached, 10);
    } catch {
      // Redis unavailable — fall through to DB
    }

    const total = await Usage.getTodayUsage(userId);

    try {
      // Cache for 5 minutes
      await redisClient.setex(cacheKey, 300, total.toString());
    } catch { /* ignore */ }

    return total;
  },

  /**
   * Get this month's usage count for a user.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  getMonthUsage: async (userId) => {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    return Usage.getMonthUsage(userId, month);
  },

  /**
   * Check whether a user is within their daily/monthly limits.
   *
   * @param {string} userId
   * @param {string} plan   - 'free' | 'pro' | 'premium'
   * @returns {Promise<{ allowed: boolean; reason?: string }>}
   */
  canUse: async (userId, plan = 'free') => {
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // Premium users have no limits
    if (limits.daily === -1) return { allowed: true };

    const [dailyCount, monthlyCount] = await Promise.all([
      usageService.getTodayUsage(userId),
      usageService.getMonthUsage(userId),
    ]);

    if (dailyCount >= limits.daily) {
      return {
        allowed: false,
        reason:  `Daily limit of ${limits.daily} tool uses reached. Upgrade your plan to continue.`,
      };
    }

    if (monthlyCount >= limits.monthly) {
      return {
        allowed: false,
        reason:  `Monthly limit of ${limits.monthly} tool uses reached. Upgrade your plan to continue.`,
      };
    }

    return { allowed: true };
  },

  /**
   * Record a tool use in the database and invalidate cache.
   *
   * @param {string} userId
   * @param {string} tool      - Tool slug (e.g. 'pdf-compress')
   * @param {string} category  - Tool category
   * @param {number} bytes     - File size in bytes (0 for text tools)
   */
  record: async (userId, tool, category, bytes = 0) => {
    try {
      await Usage.incrementUsage(userId, tool, category, bytes);

      // Invalidate daily cache
      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `usage:daily:${userId}:${today}`;
      await redisClient.del(cacheKey).catch(() => {});

      logger.info('Usage recorded', { userId, tool, category, bytes });
    } catch (err) {
      // Don't let usage tracking failures break the main flow
      logger.error('Usage record failed', { userId, tool, error: err.message });
    }
  },

  /**
   * Get usage summary for dashboard display.
   *
   * @param {string} userId
   * @param {string} plan
   * @returns {Promise<object>}
   */
  getSummary: async (userId, plan = 'free') => {
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const month  = new Date().toISOString().slice(0, 7);

    const [dailyUsed, monthlyUsed] = await Promise.all([
      usageService.getTodayUsage(userId),
      usageService.getMonthUsage(userId),
    ]);

    return {
      daily: {
        used:  dailyUsed,
        limit: limits.daily,
        remaining: limits.daily === -1 ? null : Math.max(0, limits.daily - dailyUsed),
      },
      monthly: {
        used:  monthlyUsed,
        limit: limits.monthly,
        remaining: limits.monthly === -1 ? null : Math.max(0, limits.monthly - monthlyUsed),
        month,
      },
      isUnlimited: limits.daily === -1,
    };
  },

  /**
   * Reset daily usage for ALL users (called by cron job at midnight).
   * Since Usage records are per-date, this just clears Redis cache.
   */
  resetDailyCache: async () => {
    try {
      const pattern = 'usage:daily:*';
      const keys = await redisClient.keys(pattern);
      if (keys.length) await redisClient.del(...keys);
      logger.info('Daily usage cache cleared', { keysCleared: keys.length });
    } catch (err) {
      logger.error('Daily cache reset failed', { error: err.message });
    }
  },
};

module.exports = usageService;
