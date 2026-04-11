'use strict';

const { Router } = require('express');
const videoController = require('../controllers/videoController');
const { optionalAuth } = require('../middleware/auth');
const { apiLimiter }   = require('../middleware/rateLimiter');

const router = Router();

/**
 * POST /api/v1/video/info
 * Fetch video metadata — works for guests and logged-in users.
 */
router.post('/info',
  optionalAuth,
  apiLimiter,
  videoController.getVideoInfo
);

/**
 * POST /api/v1/video/download
 * Download video and stream back — works for guests and logged-in users.
 */
router.post('/download',
  optionalAuth,
  apiLimiter,
  videoController.downloadVideo
);

module.exports = router;
