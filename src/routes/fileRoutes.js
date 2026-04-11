'use strict';

const { Router }  = require('express');

/** Derive MIME type from filename extension, falling back to the header value. */
function resolveMime(filename, headerContentType) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const MAP = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    csv:  'text/csv',
    txt:  'text/plain',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    zip:  'application/zip',
  };
  // Prefer extension-based MIME — Cloudinary often returns 'application/octet-stream'
  // for raw files even when the actual format is known.
  return MAP[ext] || headerContentType || 'application/octet-stream';
}
const fileController = require('../controllers/fileController');
const { authenticate } = require('../middleware/auth');
const { checkUsageLimit } = require('../middleware/planAccess');
const { uploadSingle, uploadMultiple } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');

const router = Router();

// ── Proxy download — no auth required (URL itself is the credential).
// Kept BEFORE router.use(authenticate) so guests can download results.
// This avoids Cloudinary 401s when PDF/ZIP delivery is disabled on the account.
router.get('/proxy-download', async (req, res, next) => {
  try {
    const { url, name } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: 'url query param required' });
    }

    // Security: only proxy Cloudinary URLs
    if (!url.includes('cloudinary.com') && !url.startsWith('/')) {
      return res.status(400).json({ success: false, message: 'Invalid URL' });
    }

    const { cloudinary } = require('../config/cloudinary');

    // Build a signed URL from publicId so Cloudinary honours it regardless
    // of the "PDF delivery" setting.
    //
    // Cloudinary URL structure:
    //   .../RESOURCE_TYPE/upload/[TRANSFORMATIONS/]vVERSION/PUBLIC_ID.EXT
    // The version marker "vNUMBERS/" is the reliable boundary before publicId.
    // Using it avoids mistakenly including transformation strings (pg_1, q_auto…)
    // in the publicId when the regex tries to skip an optional version segment.
    let fetchUrl = url;
    try {
      const cleanUrl = url.split('?')[0]; // strip query params before parsing
      const resourceTypeMatch = cleanUrl.match(/\/(image|raw|video)\/upload\//);
      const versionBoundary   = cleanUrl.match(/\/v(\d+)\/(.+?)(?:\.[^./]+)?$/);

      if (resourceTypeMatch && versionBoundary) {
        const resourceType = resourceTypeMatch[1];
        const publicId     = versionBoundary[2]; // everything after /vNNNN/

        fetchUrl = cloudinary.url(publicId, {
          resource_type: resourceType,
          type:          'upload',
          sign_url:      true,
          secure:        true,
        });
      }
    } catch (_) { /* fall through to unsigned URL */ }

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      // Final fallback: try original URL unsigned
      const fallback = await fetch(url);
      if (!fallback.ok) {
        return res.status(502).json({ success: false, message: `Failed to fetch file (${fallback.status})` });
      }
      const filename = (typeof name === 'string' && name) ? name : 'download';
      const contentType = resolveMime(filename, fallback.headers.get('content-type'));
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', contentType);
      const buf = Buffer.from(await fallback.arrayBuffer());
      return res.send(buf);
    }

    const filename = (typeof name === 'string' && name) ? name : 'download';
    const contentType = resolveMime(filename, response.headers.get('content-type'));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', contentType);
    const buf = Buffer.from(await response.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    next(err);
  }
});

// All remaining file routes require authentication
router.use(authenticate);

router.post('/upload',
  uploadLimiter,
  checkUsageLimit,
  uploadSingle('file'),
  fileController.uploadFile
);

router.post('/upload/multiple',
  uploadLimiter,
  checkUsageLimit,
  uploadMultiple('files', 10),
  fileController.uploadFile
);

router.get('/',              fileController.getFiles);
router.get('/signed-url',    fileController.getSignedUploadUrl);
router.delete('/all',        fileController.deleteAllFiles);
router.get('/:id',           fileController.getFile);
router.delete('/:id',        fileController.deleteFile);

module.exports = router;
