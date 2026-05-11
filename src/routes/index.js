'use strict';

/**
 * Root API router — mounts all v1 feature routers.
 */

const { Router } = require('express');

const router = Router();

// ─── Health check ─────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.status(200).json({
    success:     true,
    message:     'ToolHive API is running',
    environment: process.env.NODE_ENV || 'development',
    timestamp:   new Date().toISOString(),
    uptime:      `${Math.floor(process.uptime())}s`,
    version:     'v1',
  });
});

// ─── Feature routers ──────────────────────────────────────────────────────────

router.use('/auth',          require('./authRoutes'));
router.use('/files',         require('./fileRoutes'));
router.use('/tools',         require('./toolRoutes'));
router.use('/video',         require('./videoRoutes'));
router.use('/dashboard',     require('./dashboardRoutes'));
router.use('/subscriptions', require('./subscriptionRoutes'));
// WHOIS route removed - needs proper hosting with WHOIS package

module.exports = router;
