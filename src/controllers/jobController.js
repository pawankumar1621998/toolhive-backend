'use strict';

/**
 * Job Controller — get job status, list jobs, retry failed jobs.
 */

const Job = require('../models/Job');
const { pdfQueue, imageQueue, aiQueue } = require('../queue/queues');
const { successResponse, ApiError } = require('../utils/apiResponse');

// ─── Get job by BullMQ job ID ─────────────────────────────────────────────────

exports.getJob = async (req, res) => {
  const job = await Job.findOne({ jobId: req.params.jobId, userId: req.user._id })
    .populate('fileId', 'originalName url processedUrl size');

  if (!job) throw new ApiError(404, 'Job not found');

  return successResponse(res, { job });
};

// ─── List user's jobs ─────────────────────────────────────────────────────────

exports.listJobs = async (req, res) => {
  const { page = 1, limit = 20, status, category } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { userId: req.user._id };
  if (status)   filter.status   = status;
  if (category) filter.category = category;

  const [jobs, total] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('fileId', 'originalName url processedUrl'),
    Job.countDocuments(filter),
  ]);

  return successResponse(res, {
    jobs,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
  });
};

// ─── Retry a failed job ───────────────────────────────────────────────────────

exports.retryJob = async (req, res) => {
  const jobRecord = await Job.findOne({ jobId: req.params.jobId, userId: req.user._id });
  if (!jobRecord) throw new ApiError(404, 'Job not found');
  if (jobRecord.status !== 'failed') throw new ApiError(400, 'Only failed jobs can be retried');

  // Pick the right queue
  let queue;
  switch (jobRecord.category) {
    case 'pdf':   queue = pdfQueue;   break;
    case 'image': queue = imageQueue; break;
    default:      queue = aiQueue;
  }

  const bullJob = await queue.add(jobRecord.tool, {
    tool:      jobRecord.tool,
    fileId:    jobRecord.fileId?.toString(),
    userId:    req.user._id.toString(),
    inputData: jobRecord.inputData,
  });

  // Update job record with new BullMQ job ID
  jobRecord.jobId   = bullJob.id;
  jobRecord.status  = 'pending';
  jobRecord.progress = 0;
  jobRecord.error   = undefined;
  jobRecord.retries += 1;
  await jobRecord.save();

  return successResponse(res, {
    job: { id: jobRecord._id, jobId: bullJob.id, status: 'pending' },
  }, 'Job requeued for processing');
};

// ─── Delete a job record ──────────────────────────────────────────────────────

exports.deleteJob = async (req, res) => {
  const job = await Job.findOne({ jobId: req.params.jobId, userId: req.user._id });
  if (!job) throw new ApiError(404, 'Job not found');
  await Job.findByIdAndDelete(job._id);
  return successResponse(res, null, 'Job deleted');
};
