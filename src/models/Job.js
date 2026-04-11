'use strict';

const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    // BullMQ job identifier — kept as a string because BullMQ uses numeric or
    // string IDs and we don't want Mongoose coercing them to ObjectId.
    jobId: {
      type: String,
      required: [true, 'Job ID is required'],
      unique: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
    },
    // e.g. 'pdf-compress', 'bg-remove', 'summarize'
    tool: {
      type: String,
      required: [true, 'Tool name is required'],
    },
    category: {
      type: String,
      enum: ['pdf', 'image', 'video', 'audio', 'ai-writing', 'converter'],
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    // Processing progress 0–100 percentage
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    // Original job parameters / options sent by the client
    inputData: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Result payload from the worker after successful completion
    outputData: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Human-readable error message when status === 'failed'
    error: {
      type: String,
    },
    startedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    // Total processing time in milliseconds (completedAt - startedAt)
    processingTime: {
      type: Number,
    },
    // Number of times BullMQ has retried this job
    retries: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Derived field: auto-calculate processingTime on completion ───────────────
jobSchema.pre('save', function (next) {
  if (
    this.isModified('completedAt') &&
    this.completedAt &&
    this.startedAt
  ) {
    this.processingTime = this.completedAt.getTime() - this.startedAt.getTime();
  }
  next();
});

const Job = mongoose.model('Job', jobSchema);
module.exports = Job;
