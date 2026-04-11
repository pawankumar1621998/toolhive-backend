'use strict';

/**
 * Tool Controller — handles direct (synchronous) AI tool requests.
 * For heavy/long-running jobs, delegates to queue (fileController).
 */

const aiService      = require('../services/aiService');
const usageService   = require('../services/usageService');
const { addJob }     = require('../queue/queues');
const Job            = require('../models/Job');
const { successResponse, ApiError } = require('../utils/apiResponse');

// ─── AI Writing Tools (synchronous — fast enough for direct response) ─────────

exports.runAiTool = async (req, res) => {
  const { tool } = req.params;
  const body = req.body;

  // Enforce usage limits
  const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
  if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);

  let result;

  switch (tool) {
    case 'summarize':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.summarize(body.text, body.options);
      break;

    case 'translate':
      if (!body.text || !body.targetLanguage) throw new ApiError(400, 'text and targetLanguage are required');
      result = await aiService.translate(body.text, body.targetLanguage, body.options);
      break;

    case 'rewrite':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.rewrite(body.text, body.tone || 'professional', body.options);
      break;

    case 'paraphrase':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.paraphrase(body.text, body.style || 'standard', body.options);
      break;

    case 'grammar-check':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.grammarCheck(body.text, body.options);
      break;

    case 'blog-writer':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.writeBlog(body.topic, body.keywords || [], body.tone, body.audience, body.wordCount, body.options);
      break;

    case 'email-writer':
      if (!body.subject || !body.context) throw new ApiError(400, 'subject and context are required');
      result = await aiService.writeEmail(body.subject, body.context, body.tone, body.options);
      break;

    case 'social-caption':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.socialCaption(body.topic, body.platform || 'instagram', body.tone, body.hashtags !== false, body.emojiStyle, body.options);
      break;

    case 'headline':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generateHeadlines(body.topic, body.count || 5, body.type, body.options);
      break;

    case 'instagram-bio':
      if (!body.name || !body.niche) throw new ApiError(400, 'name and niche are required');
      result = await aiService.instagramBio(body.name, body.niche, body.mood || 'professional', body.interests, body.tagline, body.bioLength, body.includeEmoji, body.options);
      break;

    case 'description':
      if (!body.title) throw new ApiError(400, 'title is required');
      result = await aiService.writeDescription(body.title, body.features, body.audience, body.tone, body.descType, body.length, body.options);
      break;

    case 'script-writer':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.writeScript(body.topic, body.scriptType, body.keyPoints || [], body.tone, body.options);
      break;

    // Resume tools
    case 'resume-analyze':
      if (!body.resumeText) throw new ApiError(400, 'resumeText is required');
      result = await aiService.analyzeResume(body.resumeText, body.jobDescription, body.options);
      break;

    case 'skills-suggest':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.suggestSkills(body.jobTitle, body.currentSkills || [], body.industry, body.experienceLevel, body.options);
      break;

    case 'cover-letter':
      if (!body.name || !body.jobTitle) throw new ApiError(400, 'name and jobTitle are required');
      result = await aiService.writeCoverLetter(body.name, body.jobTitle, body.company, body.experience, body.skills, body.options);
      break;

    case 'resume-summary':
      if (!body.name || !body.jobTitle) throw new ApiError(400, 'name and jobTitle are required');
      result = await aiService.generateResumeSummaries(body.name, body.jobTitle, body.experience, body.skills || [], body.achievement, body.tone, body.options);
      break;

    case 'interview-prep':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.prepInterviewQuestions(body.jobTitle, body.company, body.jobDescription, body.options);
      break;

    case 'linkedin-headline':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.writeLinkedInHeadlines(body.jobTitle, body.specialization, body.industry, body.value, body.options);
      break;

    case 'linkedin-about':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.writeLinkedInAbout(body.jobTitle, body.experience, body.achievements || [], body.cta, body.options);
      break;

    case 'linkedin-bullets':
      if (!body.jobTitle || !body.whatYouDid) throw new ApiError(400, 'jobTitle and whatYouDid are required');
      result = await aiService.writeLinkedInBullets(body.jobTitle, body.company, body.whatYouDid, body.results, body.options);
      break;

    default:
      result = await aiService.generic(tool, body);
  }

  // Record usage (non-blocking)
  usageService.record(req.user._id, tool, 'ai-writing', 0).catch(() => {});

  return successResponse(res, {
    tool,
    result,
    wordCount: result ? result.split(/\s+/).filter(Boolean).length : 0,
  }, 'Generated successfully');
};

// ─── Resume file analysis (memory upload + pdf-parse + structured AI) ────────

exports.analyzeResumeFile = async (req, res) => {
  const { tool, jobDescription, resumeText: bodyText } = req.body;
  if (!tool) throw new ApiError(400, 'tool is required');

  const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
  if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);

  // Extract text from uploaded file or use pasted text
  let resumeText = bodyText || '';
  if (req.file) {
    const pdfParse = require('pdf-parse');  // v1: direct function
    try {
      const parsed = await pdfParse(req.file.buffer);
      resumeText = parsed.text || '';
    } catch {
      // If parsing fails, try raw text
      resumeText = req.file.buffer.toString('utf-8');
    }
  }

  if (!resumeText.trim()) throw new ApiError(400, 'Resume text or file is required');

  let data;
  switch (tool) {
    case 'ats-check':
      data = await aiService.checkATS(resumeText, jobDescription);
      break;
    case 'job-match':
      data = await aiService.matchJob(resumeText, jobDescription);
      break;
    case 'resume-analyze-structured':
      data = await aiService.analyzeResumeDetailed(resumeText, jobDescription);
      break;
    case 'keyword-optimizer':
      data = await aiService.optimizeKeywords(resumeText, jobDescription);
      break;
    default:
      throw new ApiError(400, `Unknown resume tool: ${tool}`);
  }

  // Parse JSON result (AI should return valid JSON string)
  let parsedData;
  try {
    // Strip markdown code blocks if AI wrapped it
    const clean = data.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsedData = JSON.parse(clean);
  } catch {
    throw new ApiError(500, 'Failed to parse AI analysis result. Please try again.');
  }

  usageService.record(req.user._id, tool, 'resume', 0).catch(() => {});

  // Spread parsedData first so the explicit `tool` field always wins,
  // preventing AI output from accidentally overwriting the tool identifier.
  return successResponse(res, { ...parsedData, tool }, 'Analysis complete');
};

// ─── Queue-based tool (for async/heavy operations) ────────────────────────────

exports.queueTool = async (req, res) => {
  const { tool, category, inputData } = req.body;
  if (!tool) throw new ApiError(400, 'tool is required');

  const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
  if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);

  const bullJob = await addJob(category || 'ai', tool, {
    tool,
    userId: req.user._id.toString(),
    inputData: inputData || req.body,
  });

  const jobRecord = await Job.create({
    jobId:    bullJob.id,
    userId:   req.user._id,
    tool,
    category: category || 'ai',
    status:   'pending',
    inputData,
  });

  return successResponse(res, {
    job: { id: jobRecord._id, jobId: jobRecord.jobId, status: 'pending' },
  }, 'Job queued successfully', 202);
};

// ─── Get job status ───────────────────────────────────────────────────────────

exports.getJobStatus = async (req, res) => {
  const job = await Job.findOne({ jobId: req.params.jobId, userId: req.user._id });
  if (!job) throw new ApiError(404, 'Job not found');

  return successResponse(res, {
    job: {
      id:             job._id,
      jobId:          job.jobId,
      tool:           job.tool,
      status:         job.status,
      progress:       job.progress,
      outputData:     job.outputData,
      error:          job.error,
      processingTime: job.processingTime,
      createdAt:      job.createdAt,
      completedAt:    job.completedAt,
    },
  });
};
