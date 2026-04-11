'use strict';

/**
 * Multer + Cloudinary upload middleware.
 *
 * Provides `uploadSingle`, `uploadMultiple`, and `uploadFields` helpers that
 * stream files directly to Cloudinary (no temp files on disk).
 */

const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('../config/cloudinary');
const { ApiError } = require('../utils/apiResponse');

// ─── Allowed MIME types by category ─────────────────────────────────────────

const ALLOWED_TYPES = {
  image:    ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  pdf:      ['application/pdf'],
  video:    ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/avi', 'video/webm'],
  audio:    ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
  ],
};

const ALL_ALLOWED = [
  ...ALLOWED_TYPES.image,
  ...ALLOWED_TYPES.pdf,
  ...ALLOWED_TYPES.video,
  ...ALLOWED_TYPES.audio,
  ...ALLOWED_TYPES.document,
];

// ─── Cloudinary storage factory ──────────────────────────────────────────────

/**
 * Create a CloudinaryStorage instance for the given folder and resource type.
 *
 * @param {string} folder       - Cloudinary folder path (e.g. 'toolhive/images')
 * @param {string} resourceType - 'image' | 'video' | 'raw' | 'auto'
 */
function makeStorage(folder = 'toolhive/uploads', resourceType = 'auto') {
  return new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      // Derive a clean folder per category from the file mimetype
      let subfolder = 'misc';
      if (ALLOWED_TYPES.image.includes(file.mimetype))    subfolder = 'images';
      else if (ALLOWED_TYPES.pdf.includes(file.mimetype)) subfolder = 'pdfs';
      else if (ALLOWED_TYPES.video.includes(file.mimetype)) subfolder = 'videos';
      else if (ALLOWED_TYPES.audio.includes(file.mimetype)) subfolder = 'audio';

      const userId = req.user ? req.user._id.toString() : 'guest';

      // PDFs must be uploaded as 'raw' so Cloudinary's default PDF delivery
      // block (Security settings) does not cause 401 when workers download them.
      const effectiveResourceType =
        file.mimetype === 'application/pdf' ? 'raw' : resourceType;

      return {
        folder:        `toolhive/${userId}/${subfolder}`,
        resource_type: effectiveResourceType,
        // Use a unique public_id so re-uploads don't overwrite
        public_id:     `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        // Keep original filename accessible in Cloudinary metadata
        context:       { original_filename: file.originalname },
      };
    },
  });
}

// ─── Default storage (auto resource type) ───────────────────────────────────

const defaultStorage = makeStorage('toolhive/uploads', 'auto');

// ─── File filter ─────────────────────────────────────────────────────────────

const fileFilter = (req, file, cb) => {
  if (ALL_ALLOWED.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(400, `File type '${file.mimetype}' is not supported`),
      false
    );
  }
};

// ─── Size limits ─────────────────────────────────────────────────────────────
// Actual plan-based enforcement happens in planAccess middleware.
// Here we set a generous hard cap to prevent abuse before auth even runs.

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10) * 1024 * 1024;

// ─── Multer instance ─────────────────────────────────────────────────────────

const multerUpload = multer({
  storage:  defaultStorage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// ─── Error-handling wrapper ──────────────────────────────────────────────────
// Wraps a multer middleware so that multer errors propagate to Express's
// global error handler rather than crashing the process.

function wrapMulter(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(400, `File too large. Maximum allowed size is ${process.env.MAX_FILE_SIZE_MB || 500} MB`));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(new ApiError(400, 'Too many files. Please reduce the number of files.'));
        }
        return next(new ApiError(400, `Upload error: ${err.message}`));
      }

      next(err);
    });
  };
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Upload a single file.
 * @param {string} fieldName - Form field name (default: 'file')
 */
const uploadSingle = (fieldName = 'file') =>
  wrapMulter(multerUpload.single(fieldName));

/**
 * Upload multiple files from a single field.
 * @param {string} fieldName
 * @param {number} maxCount
 */
const uploadMultiple = (fieldName = 'files', maxCount = 5) =>
  wrapMulter(multerUpload.array(fieldName, maxCount));

/**
 * Upload files from multiple named fields.
 * @param {{ name: string; maxCount: number }[]} fields
 */
const uploadFields = (fields) =>
  wrapMulter(multerUpload.fields(fields));

module.exports = { uploadSingle, uploadMultiple, uploadFields, ALLOWED_TYPES };
