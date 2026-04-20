'use strict';

const path   = require('path');
const os     = require('os');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { Router } = require('express');
const videoController = require('../controllers/videoController');
const { optionalAuth } = require('../middleware/auth');
const { apiLimiter }   = require('../middleware/rateLimiter');

const router = Router();

// Disk-storage multer for video processing (files can be 100s of MB)
const videoProcessUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `th_upload_${randomUUID()}${path.extname(file.originalname) || '.mp4'}`),
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/avi', 'video/x-msvideo', 'video/webm', 'video/x-matroska', 'video/mpeg', 'video/3gpp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only video files are supported.'));
  },
});

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
 * GET /api/v1/video/download?url=...&quality=...
 * Browser-friendly direct download link (used as <a href> target).
 */
router.get('/download',
  optionalAuth,
  apiLimiter,
  videoController.downloadVideoGet
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

/**
 * POST /api/v1/video/process
 * FFmpeg-based video processing (compress, trim, convert, to-mp3, gif, speed, mute, merge).
 * Files uploaded via multipart/form-data; result streamed back.
 */
router.post('/process',
  optionalAuth,
  apiLimiter,
  (req, res, next) => {
    const isMerge = req.query.merge === '1';
    const upload  = isMerge
      ? videoProcessUpload.array('files', 10)
      : videoProcessUpload.single('file');
    upload(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  videoController.processVideo
);

module.exports = router;
