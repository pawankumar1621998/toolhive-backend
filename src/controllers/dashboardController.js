'use strict';

/**
 * Dashboard Controller — file history, download history, activity, usage stats.
 */

const File         = require('../models/File');
const Job          = require('../models/Job');
const Usage        = require('../models/Usage');
const usageService = require('../services/usageService');
const { successResponse } = require('../utils/apiResponse');

// ─── Dashboard overview ───────────────────────────────────────────────────────

exports.getOverview = async (req, res) => {
  const userId = req.user._id;

  const [
    totalFiles,
    processedFiles,
    recentJobs,
    usageSummary,
  ] = await Promise.all([
    File.countDocuments({ userId }),
    File.countDocuments({ userId, status: 'processed' }),
    Job.find({ userId }).sort({ createdAt: -1 }).limit(5).select('tool status createdAt completedAt'),
    usageService.getSummary(userId, req.user.plan),
  ]);

  return successResponse(res, {
    stats: {
      totalFiles,
      processedFiles,
      pendingFiles: totalFiles - processedFiles,
    },
    recentActivity: recentJobs,
    usage: usageSummary,
    plan: req.user.plan,
  });
};

// ─── File history ─────────────────────────────────────────────────────────────

exports.getFileHistory = async (req, res) => {
  const { page = 1, limit = 20, category, status, tool } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const userId = req.user._id;

  const filter = { userId };
  if (category) filter.category = category;
  if (status)   filter.status   = status;
  if (tool)     filter.toolUsed = tool;

  const [files, total] = await Promise.all([
    File.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('originalName url processedUrl size category toolUsed status createdAt expiresAt'),
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

// ─── Download history (processed files only) ─────────────────────────────────

exports.getDownloadHistory = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { userId: req.user._id, status: 'processed' };

  const [files, total] = await Promise.all([
    File.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('originalName processedUrl size category toolUsed createdAt'),
    File.countDocuments(filter),
  ]);

  return successResponse(res, {
    downloads: files,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
  });
};

// ─── Activity log (all jobs) ─────────────────────────────────────────────────

exports.getActivity = async (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [jobs, total] = await Promise.all([
    Job.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('tool category status progress createdAt completedAt processingTime error'),
    Job.countDocuments({ userId: req.user._id }),
  ]);

  return successResponse(res, {
    activity: jobs,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
  });
};

// ─── Usage statistics ─────────────────────────────────────────────────────────

exports.getUsageStats = async (req, res) => {
  const userId = req.user._id;
  const month  = req.query.month || new Date().toISOString().slice(0, 7);

  // Top tools this month
  const topTools = await Usage.aggregate([
    { $match: { userId, month } },
    { $group: { _id: '$tool', totalUses: { $sum: '$count' }, totalBytes: { $sum: '$bytesProcessed' } } },
    { $sort: { totalUses: -1 } },
    { $limit: 10 },
  ]);

  // Daily usage for chart (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const dailyUsage = await Usage.aggregate([
    { $match: { userId, date: { $gte: thirtyDaysAgo } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, total: { $sum: '$count' } } },
    { $sort: { _id: 1 } },
  ]);

  const summary = await usageService.getSummary(userId, req.user.plan);

  return successResponse(res, { summary, topTools, dailyUsage, month });
};
