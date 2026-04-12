'use strict';

const multer = require('multer');
const { Router }    = require('express');
const toolController = require('../controllers/toolController');
const jobController  = require('../controllers/jobController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { checkUsageLimit }            = require('../middleware/planAccess');
const { apiLimiter }                 = require('../middleware/rateLimiter');

const router = Router();

// Memory-storage multer for resume file analysis (no Cloudinary, no disk)
const resumeMemUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF, DOCX, and TXT files supported'));
  },
}).single('file');

// Resume file analysis — memory upload, no Cloudinary storage
router.post('/resume/analyze',
  optionalAuth,
  apiLimiter,
  checkUsageLimit,
  (req, res, next) => resumeMemUpload(req, res, (err) => err ? next(err) : next()),
  toolController.analyzeResumeFile
);

// AI text tools — guests allowed, usage-limited for logged-in users
router.post('/ai/:tool',
  optionalAuth,
  apiLimiter,
  checkUsageLimit,
  toolController.runAiTool
);

// Queue-based tools — guests allowed
router.post('/queue',
  optionalAuth,
  apiLimiter,
  checkUsageLimit,
  toolController.queueTool
);

// Job status polling — guests can poll their own jobs
router.get('/jobs/:jobId/status', optionalAuth, toolController.getJobStatus);

// Job management
router.get('/jobs',               authenticate, jobController.listJobs);
router.get('/jobs/:jobId',        authenticate, jobController.getJob);
router.post('/jobs/:jobId/retry', authenticate, jobController.retryJob);
router.delete('/jobs/:jobId',     authenticate, jobController.deleteJob);

// ── Dev-only: reset today's usage for the authenticated user ──────────────────
if (process.env.NODE_ENV !== 'production') {
  const Usage = require('../models/Usage');
  router.post('/dev/reset-usage', authenticate, async (req, res) => {
    try {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      await Usage.deleteMany({ userId: req.user._id, date: { $gte: today, $lt: tomorrow } });
      res.json({ success: true, message: 'Today\'s usage reset.' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

module.exports = router;
