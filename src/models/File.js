'use strict';

const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    originalName: {
      type: String,
      required: [true, 'Original file name is required'],
    },
    filename: {
      type: String,
      required: [true, 'Filename is required'],
    },
    mimetype: {
      type: String,
      required: [true, 'MIME type is required'],
    },
    // Size in bytes
    size: {
      type: Number,
      required: [true, 'File size is required'],
    },
    // Cloudinary secure URL
    url: {
      type: String,
      required: [true, 'File URL is required'],
    },
    // Cloudinary public_id — needed to delete/transform the asset
    publicId: {
      type: String,
    },
    category: {
      type: String,
      enum: ['pdf', 'image', 'video', 'audio', 'document', 'other'],
    },
    // Name of the tool that processed this file, e.g. 'pdf-compress'
    toolUsed: {
      type: String,
    },
    status: {
      type: String,
      enum: ['uploaded', 'processing', 'processed', 'failed', 'deleted'],
      default: 'uploaded',
      index: true,
    },
    // Cloudinary URL for the tool-processed output
    processedUrl: {
      type: String,
    },
    processedPublicId: {
      type: String,
    },
    // TTL field: files expire 1 hour after upload; a cron job or TTL index
    // should clean up documents and Cloudinary assets after this date.
    expiresAt: {
      type: Date,
    },
    // Arbitrary extra data from the processing pipeline (dimensions, pages, etc.)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true, // createdAt + updatedAt
  }
);

// ─── Additional indexes ───────────────────────────────────────────────────────
fileSchema.index({ createdAt: 1 });

// TTL index: MongoDB will automatically remove expired documents.
// Adjust the expireAfterSeconds as needed (0 = remove at expiresAt exactly).
fileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Pre-save hook: default expiresAt to 72 hours after creation ─────────────
fileSchema.pre('save', function (next) {
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // +72 hours
  }
  next();
});

const File = mongoose.model('File', fileSchema);
module.exports = File;
