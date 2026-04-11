'use strict';

const Subscription = require('../models/Subscription');
const Usage = require('../models/Usage');

// ─── Plan hierarchy: higher number = higher tier ──────────────────────────────
const PLAN_RANK = {
  free: 0,
  pro: 1,
  premium: 2,
};

// ─── checkPlan ────────────────────────────────────────────────────────────────
// Middleware factory that blocks users whose plan is below the minimum required.
//
// Usage:
//   router.post('/premium-tool', authenticate, checkPlan('pro'), handler)
const checkPlan = (minPlan) => {
  return (req, res, next) => {
    const userPlan = req.user && req.user.plan ? req.user.plan : 'free';
    const userRank = PLAN_RANK[userPlan] ?? 0;
    const requiredRank = PLAN_RANK[minPlan] ?? 0;

    if (userRank < requiredRank) {
      return res.status(403).json({
        success: false,
        message: `Upgrade to ${minPlan} plan required`,
        requiredPlan: minPlan,
        currentPlan: userPlan,
      });
    }

    next();
  };
};

// ─── checkUsageLimit ─────────────────────────────────────────────────────────
// Checks whether the authenticated user has exceeded their daily limit.
// Looks up the user's active subscription to get accurate limits (falls back
// to the plan embedded on req.user if no subscription record exists).
//
// Sets req.usageOk = true when the request is allowed through.
const checkUsageLimit = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const userPlan = req.user.plan || 'free';

    // ── Resolve the daily limit ───────────────────────────────────────────────
    let dailyLimit;

    // Try to get the limit from the Subscription document first (most accurate)
    const subscription = await Subscription.findOne({ userId }).lean();

    // Always use the static PLAN_FEATURES as the authoritative limit.
    // The subscription doc may have a stale/lower value from a previous config.
    const planFeatures = Subscription.PLAN_FEATURES[userPlan];
    dailyLimit = planFeatures ? planFeatures.dailyLimit : 50;

    // If the subscription doc grants a HIGHER limit (e.g. manually upgraded), honour it.
    if (subscription && subscription.features && subscription.features.dailyLimit !== undefined) {
      const subLimit = subscription.features.dailyLimit;
      if (subLimit === -1 || (dailyLimit !== -1 && subLimit > dailyLimit)) {
        dailyLimit = subLimit;
      }
    }

    // -1 means unlimited (premium plan)
    if (dailyLimit === -1) {
      req.usageOk = true;
      return next();
    }

    // ── Check today's usage ───────────────────────────────────────────────────
    const todayCount = await Usage.getTodayUsage(userId);

    if (todayCount >= dailyLimit) {
      return res.status(429).json({
        success: false,
        message:
          userPlan === 'free'
            ? 'Daily limit reached. Upgrade to Pro.'
            : `Daily limit of ${dailyLimit} requests reached. Please try again tomorrow.`,
        dailyLimit,
        used: todayCount,
      });
    }

    req.usageOk = true;
    next();
  } catch (err) {
    next(err);
  }
};

// ─── trackUsage ──────────────────────────────────────────────────────────────
// Middleware factory that increments usage counters AFTER the response is sent.
// Non-blocking: any error in tracking is logged but does NOT fail the request.
//
// Usage:
//   router.post('/compress', authenticate, trackUsage('pdf-compress', 'pdf'), handler)
const trackUsage = (tool, category) => {
  return (req, res, next) => {
    // Listen for the response finish event so tracking runs after the handler
    res.on('finish', () => {
      // Only count successful responses (2xx / 3xx)
      if (res.statusCode >= 200 && res.statusCode < 400) {
        const userId = req.user && req.user._id;
        if (!userId) return;

        // Determine bytes processed from the uploaded file (if available)
        const bytes =
          (req.uploadedFile && req.uploadedFile.size) ||
          (req.file && req.file.size) ||
          0;

        Usage.incrementUsage(userId, tool, category, bytes).catch((err) => {
          // Log but never propagate — usage tracking is best-effort
          console.error('[trackUsage] Failed to increment usage:', err.message);
        });
      }
    });

    next();
  };
};

module.exports = { checkPlan, checkUsageLimit, trackUsage };
