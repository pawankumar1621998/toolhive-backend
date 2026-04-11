'use strict';

/**
 * File Controller — upload, list, delete, and get file info.
 */

const File           = require('../models/File');
const Job            = require('../models/Job');
const { addJob }     = require('../queue/queues');
const usageService   = require('../services/usageService');
const storageService = require('../services/storageService');
const { successResponse, ApiError } = require('../utils/apiResponse');
const logger         = require('../utils/logger');

// ─── Upload a file ────────────────────────────────────────────────────────────

exports.uploadFile = async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No file uploaded');

  const { tool, category, options } = req.body;
  const uploadedFile = req.file;

  // Check usage limit before creating a file record
  const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
  if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);

  // Save file record
  const file = await File.create({
    userId:       req.user._id,
    originalName: uploadedFile.originalname,
    filename:     uploadedFile.filename || uploadedFile.public_id,
    mimetype:     uploadedFile.mimetype,
    size:         uploadedFile.size,
    url:          uploadedFile.path,        // Cloudinary secure_url
    publicId:     uploadedFile.filename,    // Cloudinary public_id
    category:     detectCategory(uploadedFile.mimetype),
    toolUsed:     tool,
    expiresAt:    new Date(Date.now() + 72 * 60 * 60 * 1000), // 72 hours
    metadata:     { originalname: uploadedFile.originalname },
  });

  // Queue processing job if tool is specified
  let jobRecord = null;
  if (tool) {
    const jobCategory = category || file.category;
    const bullJob = await addJob(jobCategory, tool, {
      tool,
      fileId:  file._id.toString(),
      userId:  req.user._id.toString(),
      options: options ? JSON.parse(options) : {},
    });

    jobRecord = await Job.create({
      jobId:     bullJob.id,
      userId:    req.user._id,
      fileId:    file._id,
      tool,
      category:  jobCategory,
      status:    'pending',
      inputData: options ? JSON.parse(options) : {},
    });

    await File.findByIdAndUpdate(file._id, { status: 'processing' });
  }

  // Record usage
  await usageService.record(req.user._id, tool || 'upload', file.category, file.size);

  return successResponse(res, {
    file: {
      id:           file._id,
      originalName: file.originalName,
      url:          file.url,
      size:         file.size,
      category:     file.category,
      status:       file.status,
      expiresAt:    file.expiresAt,
    },
    job: jobRecord ? {
      id:     jobRecord._id,
      jobId:  jobRecord.jobId,
      status: jobRecord.status,
    } : null,
  }, 'File uploaded successfully', 201);
};

// ─── Get user's files ─────────────────────────────────────────────────────────

exports.getFiles = async (req, res) => {
  const { page = 1, limit = 20, category, status } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { userId: req.user._id };
  if (category) filter.category = category;
  if (status)   filter.status   = status;

  const [files, total] = await Promise.all([
    File.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-publicId -processedPublicId'),
    File.countDocuments(filter),
  ]);

  return successResponse(res, {
    files,
    pagination: {
      total,
      page:       parseInt(page),
      limit:      parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    },
  });
};

// ─── Get single file ──────────────────────────────────────────────────────────

exports.getFile = async (req, res) => {
  const file = await File.findOne({ _id: req.params.id, userId: req.user._id });
  if (!file) throw new ApiError(404, 'File not found');
  return successResponse(res, { file });
};

// ─── Delete file ──────────────────────────────────────────────────────────────

exports.deleteFile = async (req, res) => {
  const file = await File.findOne({ _id: req.params.id, userId: req.user._id });
  if (!file) throw new ApiError(404, 'File not found');

  // Delete from Cloudinary
  if (file.publicId) {
    await storageService.delete(file.publicId).catch((err) =>
      logger.warn('Cloudinary delete failed during file deletion', { error: err.message })
    );
  }
  if (file.processedPublicId) {
    await storageService.delete(file.processedPublicId).catch(() => {});
  }

  await File.findByIdAndDelete(file._id);
  await Job.deleteMany({ fileId: file._id });

  return successResponse(res, null, 'File deleted successfully');
};

// ─── Delete all files for the current user ────────────────────────────────────

exports.deleteAllFiles = async (req, res) => {
  const files = await File.find({ userId: req.user._id });

  await Promise.all(
    files.map(async (file) => {
      if (file.publicId) await storageService.delete(file.publicId).catch(() => {});
      if (file.processedPublicId) await storageService.delete(file.processedPublicId).catch(() => {});
    })
  );

  await File.deleteMany({ userId: req.user._id });
  await Job.deleteMany({ userId: req.user._id });

  return successResponse(res, null, 'All files deleted successfully');
};

// ─── Get signed upload URL (for direct browser uploads) ──────────────────────

exports.getSignedUploadUrl = async (req, res) => {
  const { folder } = req.query;
  const signed = storageService.generateSignedUrl({
    folder: `toolhive/${req.user._id}/${folder || 'uploads'}`,
  });
  return successResponse(res, signed);
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function detectCategory(mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype.startsWith('image/'))  return 'image';
  if (mimetype.startsWith('video/'))  return 'video';
  if (mimetype.startsWith('audio/'))  return 'audio';
  return 'document';
}
