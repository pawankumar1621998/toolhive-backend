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

  // Enforce usage limits (skip for guests)
  if (req.user) {
    const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
    if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);
  }

  let result;
  const lang = body.language;
  const opts = (extra = {}) => ({ ...(body.options || {}), language: lang, ...extra });

  switch (tool) {
    case 'summarize':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.summarize(body.text, opts());
      break;

    case 'translate':
      if (!body.text || !body.targetLanguage) throw new ApiError(400, 'text and targetLanguage are required');
      result = await aiService.translate(body.text, body.targetLanguage, body.options);
      break;

    case 'rewrite':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.rewrite(body.text, body.tone || 'professional', opts());
      break;

    case 'paraphrase':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.paraphrase(body.text, body.style || 'standard', opts());
      break;

    case 'grammar-check':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.grammarCheck(body.text, opts());
      break;

    case 'blog-writer':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.writeBlog(body.topic, body.keywords || [], body.tone, body.audience, body.wordCount, opts());
      break;

    case 'email-writer':
      if (!body.emailType || !body.context) throw new ApiError(400, 'emailType and context are required');
      result = await aiService.writeEmail(body.emailType, body.context, body.tone, opts());
      break;

    case 'social-caption':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.socialCaption(body.topic, body.platform || 'instagram', body.tone, body.hashtags !== false, body.emojiPref, opts());
      break;

    case 'headline':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generateHeadlines(body.topic, body.count || 5, body.type, opts());
      break;

    case 'instagram-bio':
      if (!body.mood) throw new ApiError(400, 'mood is required');
      result = await aiService.instagramBio(body.name, body.details || body.niche || '', body.mood, body.interests, body.tagline, body.bioLength, body.includeEmoji, opts());
      break;

    case 'description':
      if (!body.title) throw new ApiError(400, 'title is required');
      result = await aiService.writeDescription(body.title, body.features, body.audience, body.tone, body.type, body.length, opts());
      break;

    case 'script-writer':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.writeScript(body.topic, body.platform, body.keyPoints || [], body.style, opts({ maxTokens: 2000 }));
      break;

    case 'story-generator':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generic('story-generator', `Write a ${body.wordCount || 500}-word ${body.genre || 'General'} story about: "${body.topic}"\nMood: ${body.emotion || 'Happy'}\n${body.characters ? `Characters: ${body.characters}` : ''}`, opts({ maxTokens: 2000 }));
      break;

    case 'note-maker':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generic('note-maker', `Create ${body.detail || 'Standard'} study notes about: "${body.topic}"\nFormat: ${body.format || 'Bullet Points'}\n\nInclude key concepts, important points, and examples.`, opts());
      break;

    case 'article-writer':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generic('article-writer', `Write a complete ${body.wordCount || 800}-word ${body.tone || 'Informative'} article about: "${body.topic}"\n${body.sections ? `Include sections: ${body.sections}` : 'Include relevant sections with headings.'}\n\nWrite with proper introduction and conclusion.`, opts({ maxTokens: 2000 }));
      break;

    case 'hashtag-gen':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generic('hashtag-gen', `Generate 30 relevant hashtags for ${body.platform || 'Instagram'} about: "${body.topic}"\n${body.niche ? `Niche: ${body.niche}` : ''}\n\nGroup as: High reach (10), Medium reach (10), Niche (10). Format: #hashtag`, opts());
      break;

    case 'business-name':
      if (!body.keywords) throw new ApiError(400, 'keywords is required');
      result = await aiService.generic('business-name', `Generate 20 creative business names for:\nIndustry: ${body.industry || 'General'}\nKeywords: ${body.keywords}\nStyle: ${body.style || 'Creative'}\n\nFor each: Name + why it works (1 line). Number them.`, opts());
      break;

    case 'ad-copy':
      if (!body.product) throw new ApiError(400, 'product is required');
      result = await aiService.generic('ad-copy', `Generate 3 high-converting ad copy variations for:\nProduct: ${body.product}\nPlatform: ${body.platform || 'Facebook Ads'}\nBenefits: ${body.benefits || ''}\nTone: ${body.tone || 'Persuasive'}\n\nFor each: Headline (30 chars), Description (90 chars), CTA. Number them.`, opts());
      break;

    case 'roast-gen':
      if (!body.name) throw new ApiError(400, 'name is required');
      result = await aiService.generic('roast-gen', `Write a funny, lighthearted roast for "${body.name}". Traits: ${body.traits || 'not specified'}. Keep it playful and friendly. 5-7 roast lines.`, opts());
      break;

    case 'dad-jokes':
      result = await aiService.generic('dad-jokes', `Generate ${body.count || 10} original dad jokes${body.topic ? ` about ${body.topic}` : ''}. Format: Q: question A: answer`, opts());
      break;

    case 'emoji-translator':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.generic('emoji-translator', `Translate this text into emojis:\n"${body.text}"\nAlso provide a "Full Emoji Version" using only emojis.`, opts());
      break;

    case 'shakespeare':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.generic('shakespeare', `Translate this modern text into Shakespearean English (thee, thou, hast, dost, etc.):\n"${body.text}"\nMake it dramatic and theatrical!`, opts());
      break;

    case 'corporate-jargon':
      if (!body.text) throw new ApiError(400, 'text is required');
      result = await aiService.generic('corporate-jargon', `Rewrite this simple statement using maximum corporate buzzwords:\n"${body.text}"\nInclude: synergize, leverage, bandwidth, circle back, move the needle, deep dive, etc.`, opts());
      break;

    case 'fortune-cookie':
      result = await aiService.generic('fortune-cookie', `Generate 5 unique fortune cookie messages${body.theme ? ` with a ${body.theme} theme` : ''}. Each fortune 1-2 sentences, cryptic yet meaningful. Format each as: 🥠 [Fortune here]`, opts());
      break;

    case 'excuse-gen':
      if (!body.situation) throw new ApiError(400, 'situation is required');
      result = await aiService.generic('excuse-gen', `Generate 5 creative, funny excuses for: "${body.situation}"\nCreativity level: ${body.creativity || 'Medium'}\nMake them funny but plausible. Number them 1-5.`, opts());
      break;

    case 'compliment-gen':
      result = await aiService.generic('compliment-gen', `Generate ${body.count || 5} ${body.vibe || 'funny'} compliments${body.name ? ` for ${body.name}` : ''}.\nMake them genuine with the right vibe. Number them.`, opts());
      break;

    case 'poem-gen':
      if (!body.topic) throw new ApiError(400, 'topic is required');
      result = await aiService.generic('poem-gen', `Write a beautiful ${body.style || 'Free Verse'} poem about: "${body.topic}"\nMood: ${body.mood || 'Thoughtful'}\n\nWrite ONLY the poem. Use vivid imagery, rhythm, and emotion.`, opts());
      break;

    case 'song-lyrics':
      if (!body.theme) throw new ApiError(400, 'theme is required');
      result = await aiService.generic('song-lyrics', `Write original ${body.genre || 'Pop'} song lyrics.\nTheme: ${body.theme}\nMood: ${body.mood || 'Uplifting'}\n${body.hook ? `Hook phrase: ${body.hook}` : ''}\n\nStructure: [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Chorus], [Bridge], [Final Chorus]`, opts({ maxTokens: 2000 }));
      break;

    case 'tagline-gen':
      if (!body.brand) throw new ApiError(400, 'brand is required');
      result = await aiService.generic('tagline-gen', `Generate 10 catchy taglines for: "${body.brand}"\nIndustry: ${body.industry || 'General'}\nVibe: ${body.vibe || 'Bold'}\n${body.audience ? `Target audience: ${body.audience}` : ''}\n\nVaried options: 2 bold, 2 witty, 2 inspirational, 2 minimal, 2 question-based. Max 8 words each.`, opts());
      break;

    case 'speech-writer':
      if (!body.aboutPerson) throw new ApiError(400, 'aboutPerson is required');
      result = await aiService.generic('speech-writer', `Write a complete ${body.tone || 'Heartfelt'} ${body.occasion || 'Speech'}.\n${body.speakerName ? `Speaker: ${body.speakerName}` : ''}\nAbout/for: ${body.aboutPerson}\nDuration: ${body.duration || '3 minutes'}\n${body.personalDetails ? `Personal details: ${body.personalDetails}` : ''}\n\nStructure: Opening hook, personal story, heartfelt message, advice/wishes, memorable closing.`, opts({ maxTokens: 2000 }));
      break;

    case 'cold-dm':
      if (!body.aboutMe) throw new ApiError(400, 'aboutMe is required');
      result = await aiService.generic('cold-dm', `Write 3 cold ${body.platform || 'Instagram'} DM variations.\nPurpose: ${body.purpose || 'Collaboration'}\nAbout me: ${body.aboutMe}\n${body.aboutThem ? `About them: ${body.aboutThem}` : ''}\n${body.offer ? `Offer: ${body.offer}` : ''}\n\nRules: Not spammy, personalized, under 100 words each, clear CTA. Number each 1, 2, 3.`, opts());
      break;

    // Resume tools
    case 'resume-analyze':
      if (!body.resumeText) throw new ApiError(400, 'resumeText is required');
      result = await aiService.analyzeResume(body.resumeText, body.jobDescription, opts());
      break;

    case 'skills-suggest':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.suggestSkills(body.jobTitle, body.currentSkills || [], body.industry, body.experienceLevel, opts());
      break;

    case 'cover-letter':
      if (!body.name || !body.jobTitle) throw new ApiError(400, 'name and jobTitle are required');
      result = await aiService.writeCoverLetter(body.name, body.jobTitle, body.company, body.experience, body.skills, opts());
      break;

    case 'resume-summary':
      if (!body.name || !body.jobTitle) throw new ApiError(400, 'name and jobTitle are required');
      result = await aiService.generateResumeSummaries(body.name, body.jobTitle, body.experience, body.skills || [], body.achievement, body.tone, opts());
      break;

    case 'interview-prep':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.prepInterviewQuestions(body.jobTitle, body.company, body.jobDescription, opts());
      break;

    case 'linkedin-headline':
    case 'linkedin-headlines':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.writeLinkedInHeadlines(body.jobTitle, body.specialization, body.industry, body.value, opts());
      break;

    case 'linkedin-about':
      if (!body.jobTitle) throw new ApiError(400, 'jobTitle is required');
      result = await aiService.writeLinkedInAbout(body.jobTitle, body.experience, body.achievements || [], body.cta, opts());
      break;

    case 'linkedin-bullets':
      if (!body.jobTitle || !body.whatYouDid) throw new ApiError(400, 'jobTitle and whatYouDid are required');
      result = await aiService.writeLinkedInBullets(body.jobTitle, body.company, body.whatYouDid, body.results, opts());
      break;

    default:
      result = await aiService.generic(tool, body, opts());
  }

  // Record usage (non-blocking, skip for guests)
  if (req.user) usageService.record(req.user._id, tool, 'ai-writing', 0).catch(() => {});

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

  if (req.user) {
    const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
    if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);
  }

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

  if (req.user) usageService.record(req.user._id, tool, 'resume', 0).catch(() => {});

  // Spread parsedData first so the explicit `tool` field always wins,
  // preventing AI output from accidentally overwriting the tool identifier.
  return successResponse(res, { ...parsedData, tool }, 'Analysis complete');
};

// ─── Queue-based tool (for async/heavy operations) ────────────────────────────

exports.queueTool = async (req, res) => {
  const { tool, category, inputData } = req.body;
  if (!tool) throw new ApiError(400, 'tool is required');

  if (req.user) {
    const usageCheck = await usageService.canUse(req.user._id, req.user.plan);
    if (!usageCheck.allowed) throw new ApiError(429, usageCheck.reason);
  }

  const userId = req.user ? req.user._id : null;

  const bullJob = await addJob(category || 'ai', tool, {
    tool,
    userId: userId ? userId.toString() : 'guest',
    inputData: inputData || req.body,
  });

  const jobRecord = await Job.create({
    jobId:    bullJob.id,
    userId,
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
  const query = req.user
    ? { jobId: req.params.jobId, userId: req.user._id }
    : { jobId: req.params.jobId };
  const job = await Job.findOne(query);
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
