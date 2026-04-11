'use strict';

/**
 * AI Service — wraps DeepSeek (primary), Groq (fallback), Gemini, and OpenAI.
 *
 * Provider priority: DeepSeek → Groq → Gemini → OpenAI
 */

const Groq = require('groq-sdk');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// ─── Client initialisation ───────────────────────────────────────────────────

let groqClient    = null;
let openaiClient  = null;
let geminiClient  = null;
let deepseekClient = null;

function getDeepSeek() {
  if (!deepseekClient) {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set');
    deepseekClient = new OpenAI({
      apiKey:  process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com/v1',
    });
  }
  return deepseekClient;
}

function getGroq() {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

function getOpenAI() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function getGemini() {
  if (!geminiClient) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return geminiClient;
}

// ─── Core text generation — provider waterfall ───────────────────────────────

/**
 * Generate text using DeepSeek (primary) → Groq → Gemini → OpenAI.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [options] — { provider, model, temperature, maxTokens }
 */
async function generateText(systemPrompt, userPrompt, options = {}) {
  // 1. DeepSeek-V3 (primary — best for writing tasks)
  if (!options.provider && process.env.DEEPSEEK_API_KEY) {
    try {
      return await generateWithDeepSeek(systemPrompt, userPrompt, options);
    } catch (err) {
      logger.warn('DeepSeek failed, falling back to Groq', { error: err.message });
    }
  }

  // 2. Groq / Llama-3.3-70B (free fallback)
  if (!options.provider && process.env.GROQ_API_KEY) {
    try {
      return await generateWithGroq(systemPrompt, userPrompt, options);
    } catch (err) {
      logger.warn('Groq failed, falling back to Gemini', { error: err.message });
    }
  }

  // 3. Gemini Flash (free fallback)
  if (!options.provider && process.env.GEMINI_API_KEY) {
    try {
      return await generateWithGemini(systemPrompt, userPrompt, options);
    } catch (err) {
      logger.warn('Gemini failed, falling back to OpenAI', { error: err.message });
    }
  }

  // 4. OpenAI (last resort)
  try {
    return await generateWithOpenAI(systemPrompt, userPrompt, options);
  } catch (err) {
    logger.error('All AI providers failed', { error: err.message });
    throw new Error('AI generation failed — all providers exhausted. Please try again.');
  }
}

async function generateWithDeepSeek(systemPrompt, userPrompt, options = {}) {
  const client = getDeepSeek();
  const response = await client.chat.completions.create({
    model:       options.model || 'deepseek-chat', // DeepSeek-V3 — best for writing
    temperature: options.temperature ?? 0.7,
    max_tokens:  options.maxTokens || 1500,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
  return response.choices[0].message.content.trim();
}

async function generateWithGroq(systemPrompt, userPrompt, options = {}) {
  const client = getGroq();
  const response = await client.chat.completions.create({
    model:       options.model || 'llama-3.3-70b-versatile',
    temperature: options.temperature ?? 0.7,
    max_tokens:  options.maxTokens || 1500,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
  return response.choices[0].message.content.trim();
}

async function generateWithOpenAI(systemPrompt, userPrompt, options = {}) {
  const client = getOpenAI();
  const response = await client.chat.completions.create({
    model:       options.model || 'gpt-4o-mini',
    temperature: options.temperature ?? 0.7,
    max_tokens:  options.maxTokens || 1500,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
  return response.choices[0].message.content.trim();
}

async function generateWithGemini(systemPrompt, userPrompt, options = {}) {
  const genAI  = getGemini();
  const model  = genAI.getGenerativeModel({
    model: options.model || 'gemini-1.5-flash',
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens || 1500,
    },
    systemInstruction: systemPrompt,
  });

  const result = await model.generateContent(userPrompt);
  return result.response.text().trim();
}

// ─── Tool-specific helpers ────────────────────────────────────────────────────

const aiService = {

  /** Summarise a long piece of text */
  summarize: (text, options = {}) => generateText(
    'You are an expert summariser. Create a concise, accurate summary that captures the key points. Return only the summary, no preamble.',
    `Summarise the following text in ${options.length || 'medium'} length${options.format ? ` using ${options.format} format` : ''}:\n\n${text}`,
    options
  ),

  /** Translate text to target language */
  translate: (text, targetLanguage, options = {}) => generateText(
    `You are a professional translator. Translate text accurately to ${targetLanguage}, preserving tone and meaning. Return only the translated text.`,
    text,
    options
  ),

  /** Rewrite text with given tone */
  rewrite: (text, tone = 'professional', options = {}) => generateText(
    `You are an expert writer. Rewrite the provided text in a ${tone} tone while preserving the original meaning. Return only the rewritten text.`,
    text,
    options
  ),

  /** Paraphrase text with given style */
  paraphrase: (text, style = 'standard', options = {}) => generateText(
    `You are a skilled writer. Paraphrase the text using a ${style} style — different wording but same meaning. Return only the paraphrased text.`,
    text,
    options
  ),

  /** Grammar and spelling correction */
  grammarCheck: (text, options = {}) => generateText(
    'You are a professional editor. Fix all grammar, spelling, and punctuation errors. Return only the corrected text with no explanations.',
    text,
    options
  ),

  /** Generate a blog post */
  writeBlog: (topic, keywords = [], tone = 'informative', audience = '', wordCount = '~800', options = {}) => generateText(
    `You are an expert blog writer. Write engaging, SEO-friendly blog posts in a ${tone} tone.`,
    `Write a detailed blog post about: "${topic}"\nKeywords to include: ${keywords.join(', ') || 'not specified'}\nTone: ${tone}\n${audience ? `Target audience: ${audience}\n` : ''}Target word count: ${wordCount}\nInclude a title, introduction, 3-5 sections with headings, and a conclusion.`,
    { ...options, maxTokens: 2000 }
  ),

  /** Write a professional email */
  writeEmail: (subject, context, tone = 'professional', options = {}) => generateText(
    `You are a professional email writer. Write clear, concise emails in a ${tone} tone.`,
    `Write an email with subject: "${subject}"\nContext: ${context}\nFormat: Subject line, greeting, body paragraphs, sign-off.`,
    options
  ),

  /** Generate social media captions */
  socialCaption: (topic, platform = 'instagram', tone = 'engaging', hashtags = true, emojiStyle = 'Minimal', options = {}) => generateText(
    `You are a social media expert. Write viral, engaging captions optimised for ${platform}.`,
    `Write 3 caption options for: "${topic}"\nPlatform: ${platform}\nTone: ${tone}\nEmoji style: ${emojiStyle} (none = no emojis, minimal = 1-2, moderate = 3-5, heavy = many)\n${hashtags ? 'Include relevant hashtags at the end of each caption.' : 'Do NOT include any hashtags.'}\nSeparate each caption with a blank line.`,
    options
  ),

  /** Generate headline options */
  generateHeadlines: (topic, count = 5, type = 'Blog Post', options = {}) => generateText(
    'You are a headline copywriter. Write compelling, click-worthy headlines.',
    `Generate ${count} headline options for: "${topic}"\nContent type: ${type}\nReturn as a numbered list, one headline per line.`,
    options
  ),

  /** Generate Instagram bio */
  instagramBio: (name, niche, mood = 'professional', interests = '', tagline = '', bioLength = 'medium', includeEmoji = true, options = {}) => {
    const lineCount = bioLength === 'short' ? '2-3 lines' : bioLength === 'long' ? '5-6 lines' : '3-4 lines';
    const emojiRule = includeEmoji
      ? 'Start each line with a fitting, relevant emoji.'
      : 'Do NOT use any emojis anywhere.';
    return generateText(
      'You are an expert Instagram bio writer. You craft punchy, personality-packed, multi-line Instagram bios that instantly communicate who someone is, what they do, and why people should follow them.',
      `Write 3 complete, ready-to-use Instagram bio variations for:
Name: ${name}
Role / Niche: ${niche}
Mood / Vibe: ${mood}
${interests ? `Interests: ${interests}` : ''}
${tagline ? `Tagline idea: ${tagline}` : ''}

Requirements:
- Each bio must have exactly ${lineCount}, each line short and punchy
- ${emojiRule}
- Cover these in the lines: identity or role | personality or tagline | interests, location, or achievement | call-to-action or link hint
- Keep total characters under 150 (Instagram's bio limit)
- Separate the 3 bios with a line containing only "---"
- Do NOT add labels like "Bio 1:", "Option 1:", or any headings — just write the bio directly`,
      { ...options, maxTokens: 600 }
    );
  },

  /** Write a product/service description */
  writeDescription: (title, features, audience, tone = 'informative', descType = 'product', length = 'medium', options = {}) => {
    const wordGuide = length === 'short' ? '50-100 words' : length === 'long' ? '250-400 words' : '150-250 words';
    const typeLabel = descType === 'service' ? 'service' : descType === 'app' ? 'app/software' : descType === 'course' ? 'online course' : 'product';
    return generateText(
      `You are a professional copywriter. Write compelling ${tone} ${typeLabel} descriptions that convert readers into customers.`,
      `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} Name: ${title}\nKey features/benefits: ${Array.isArray(features) ? features.join(', ') : features || 'not specified'}\nTarget audience: ${audience || 'general'}\nTone: ${tone}\nLength: ${wordGuide}\nWrite a compelling description only, no labels or extra commentary.`,
      options
    );
  },

  /** Write a video/podcast script */
  writeScript: (topic, scriptType = 'youtube', keyPoints = [], tone = 'energetic', options = {}) => generateText(
    `You are a professional scriptwriter for ${scriptType} content.`,
    `Topic: ${topic}\nKey points: ${keyPoints.join(', ')}\nTone: ${tone}\nWrite a complete script with hook, main content, and call-to-action.`,
    { ...options, maxTokens: 2000 }
  ),

  /** Text-to-speech (returns SSML or plain text; actual TTS via cloud) */
  prepareForTTS: (text, options = {}) => generateText(
    'You are a text editor for text-to-speech. Clean the text — remove markdown, add natural pauses (commas), fix abbreviations. Return only the cleaned text.',
    text,
    options
  ),

  /** Analyse resume and give feedback */
  analyzeResume: (resumeText, jobDescription = '', options = {}) => generateText(
    'You are an expert resume reviewer and career coach.',
    `Analyse this resume and provide:\n1. Overall score (0-100)\n2. Strengths (3 points)\n3. Weaknesses (3 points)\n4. Specific improvements\n5. ATS compatibility score\n\nResume:\n${resumeText}\n${jobDescription ? `\nJob Description:\n${jobDescription}` : ''}`,
    { ...options, maxTokens: 2000 }
  ),

  /** Suggest skills based on job title — returns JSON */
  suggestSkills: (jobTitle, currentSkills = [], industry = '', experienceLevel = '', options = {}) => generateText(
    'You are a career expert who knows current job market trends.',
    `Job title: ${jobTitle}\nIndustry: ${industry || 'Technology'}\nExperience level: ${experienceLevel || 'Mid Level'}\nCurrent skills: ${currentSkills.join(', ') || 'none listed'}\n\nReturn ONLY valid JSON, no markdown:\n{"technical":["skill1","skill2","skill3","skill4","skill5"],"soft":["skill1","skill2","skill3","skill4"],"tools":["tool1","tool2","tool3","tool4"],"certifications":["cert1","cert2","cert3"]}`,
    options
  ),

  /** Generate cover letter */
  writeCoverLetter: (name, jobTitle, company, experience, skills, options = {}) => generateText(
    'You are a professional cover letter writer. Write compelling, personalised cover letters.',
    `Candidate: ${name}\nJob: ${jobTitle} at ${company}\nExperience: ${experience}\nKey skills: ${skills}\nWrite a professional cover letter (3-4 paragraphs).`,
    { ...options, maxTokens: 800 }
  ),

  /** Generate 3 professional resume summary variations — returns JSON */
  generateResumeSummaries: (name, jobTitle, experience, skills, achievement = '', tone = 'Professional', options = {}) => generateText(
    'You are an expert resume writer. Generate exactly 3 professional resume summary variations.',
    `Name: ${name}\nTarget Role: ${jobTitle}\nExperience: ${experience} years\nTop Skills: ${skills.join(', ')}\nKey Achievement: ${achievement || 'N/A'}\nTone preference: ${tone}\n\nReturn ONLY valid JSON, no markdown:\n[{"label":"Professional","summary":"..."},{"label":"Dynamic","summary":"..."},{"label":"Creative","summary":"..."}]\nEach summary should be 2-3 sentences, tailored to the role.`,
    { ...options, maxTokens: 1000 }
  ),

  /** Generate interview questions by category — returns JSON */
  prepInterviewQuestions: (jobTitle, company = '', jobDescription = '', options = {}) => generateText(
    'You are an expert interview coach. Generate realistic, role-specific interview questions with detailed model answers.',
    `Job Title: ${jobTitle}\nCompany: ${company || 'a company'}\nJob Description: ${jobDescription || 'not provided'}\n\nReturn ONLY valid JSON, no markdown, no code blocks:\n{"behavioral":[{"id":1,"text":"question text","modelAnswer":"detailed answer using STAR method","practiced":false}],"technical":[{"id":6,"text":"...","modelAnswer":"...","practiced":false}],"situational":[{"id":11,"text":"...","modelAnswer":"...","practiced":false}],"about":[{"id":16,"text":"...","modelAnswer":"...","practiced":false}]}\nInclude 4-5 questions per category. Keep id numbers sequential (1-5 behavioral, 6-10 technical, 11-15 situational, 16-18 about).`,
    { ...options, maxTokens: 3000 }
  ),

  /** Generate LinkedIn headlines — returns JSON array */
  writeLinkedInHeadlines: (jobTitle, specialization = '', industry = '', value = '', options = {}) => generateText(
    'You are a LinkedIn profile expert. Write compelling, keyword-rich headlines under 220 characters.',
    `Job Title: ${jobTitle}\nSpecialization: ${specialization || 'general'}\nIndustry: ${industry || 'Technology'}\nUnique Value: ${value || 'not specified'}\n\nReturn ONLY a JSON array of exactly 5 strings, no markdown:\n["headline1","headline2","headline3","headline4","headline5"]`,
    options
  ),

  /** Write LinkedIn About section */
  writeLinkedInAbout: (jobTitle, experience = '', achievements = [], cta = '', options = {}) => generateText(
    'You are a LinkedIn profile writer. Write engaging About sections that attract recruiters and tell a compelling story.',
    `Job Title: ${jobTitle}\nYears of Experience: ${experience || 'several years'}\nTop Achievements:\n${achievements.filter(Boolean).map((a, i) => `${i + 1}. ${a}`).join('\n') || 'Not specified'}\nCall to Action: ${cta || 'open to opportunities'}\n\nWrite a compelling LinkedIn About section (200-300 words). Return only the text, no markdown, no labels.`,
    { ...options, maxTokens: 500 }
  ),

  /** Generate LinkedIn experience bullet points — returns JSON array */
  writeLinkedInBullets: (jobTitle, company = '', whatYouDid = '', results = '', options = {}) => generateText(
    'You are a LinkedIn resume writer. Write strong, quantified bullet points using the XYZ (Accomplished X by doing Y which resulted in Z) format.',
    `Job Title: ${jobTitle}\nCompany: ${company || 'the company'}\nWhat you did: ${whatYouDid}\nResults/Impact: ${results || 'positive business impact'}\n\nReturn ONLY a JSON array of exactly 5 bullet point strings, no markdown:\n["• bullet 1","• bullet 2","• bullet 3","• bullet 4","• bullet 5"]`,
    options
  ),

  /** ATS keyword analysis — returns JSON string */
  checkATS: (resumeText, jobDescription = '', options = {}) => generateText(
    'You are an ATS (Applicant Tracking System) expert. Analyze resumes precisely against job descriptions.',
    `Resume:\n${resumeText.slice(0, 3000)}\n\nJob Description:\n${(jobDescription || 'Not provided').slice(0, 2000)}\n\nReturn ONLY valid JSON, no markdown:\n{"atsScore":75,"keywordMatch":{"found":14,"total":22,"percentage":64},"categories":[{"label":"Keyword Match","score":64,"detail":"14 of 22 keywords found"},{"label":"Format Compatibility","score":90},{"label":"Section Headers","score":85},{"label":"File Type","score":100}],"missingKeywords":["word1","word2","word3","word4","word5"],"matchedKeywords":["word1","word2","word3","word4","word5","word6"],"quickFixes":["fix1","fix2","fix3","fix4","fix5"]}`,
    { ...options, maxTokens: 1500 }
  ),

  /** Job match analysis — returns JSON matching JobMatchResult frontend type */
  matchJob: (resumeText, jobDescription = '', options = {}) => generateText(
    'You are a senior career counselor. Analyze how well a resume matches a job description.',
    `Resume:\n${resumeText.slice(0, 3000)}\n\nJob Description:\n${(jobDescription || 'Not provided').slice(0, 2000)}\n\nReturn ONLY valid JSON, no markdown, in this EXACT format:\n{"matchPercentage":72,"skillsGap":{"have":["skill1","skill2","skill3"],"missing":["skill4","skill5","skill6"]},"experience":[{"requirement":"Frontend Development","required":"3+ years","yours":"estimated from resume","match":"strong"},{"requirement":"Backend Development","required":"2+ years","yours":"estimated","match":"partial"},{"requirement":"Cloud/DevOps","required":"1+ year","yours":"0 years","match":"missing"}],"keywords":[{"keyword":"React","inJD":5,"inResume":3},{"keyword":"TypeScript","inJD":4,"inResume":0}],"recommendations":["rec1","rec2","rec3","rec4","rec5"]}`,
    { ...options, maxTokens: 2000 }
  ),

  /** Detailed resume analysis — returns JSON matching AnalysisResult frontend type */
  analyzeResumeDetailed: (resumeText, jobDescription = '', options = {}) => generateText(
    'You are an expert resume reviewer and career coach. Provide a thorough, structured analysis.',
    `Resume:\n${resumeText.slice(0, 3000)}\n${jobDescription ? `\nJob Description:\n${jobDescription.slice(0, 1500)}` : ''}\n\nReturn ONLY valid JSON, no markdown, in this EXACT format:\n{"overallScore":75,"sections":[{"label":"Contact Info","score":90},{"label":"Work Experience","score":75},{"label":"Education","score":80},{"label":"Skills","score":60},{"label":"Summary","score":45}],"issues":[{"message":"Add quantified achievements","severity":"High"},{"message":"Add professional summary","severity":"Medium"},{"message":"Use consistent date formats","severity":"Low"}]}`,
    { ...options, maxTokens: 1500 }
  ),

  /** Keyword gap optimization — returns JSON matching OptimizationResult frontend type */
  optimizeKeywords: (resumeText, jobDescription = '', options = {}) => generateText(
    'You are an ATS optimization specialist. Analyze keyword gaps between a resume and job description.',
    `Resume:\n${resumeText.slice(0, 3000)}\n\nJob Description:\n${(jobDescription || 'Not provided').slice(0, 2000)}\n\nReturn ONLY valid JSON, no markdown, in this EXACT format:\n{"overallScore":58,"densityTable":[{"keyword":"React","inResume":8,"inJD":5,"status":"Good"},{"keyword":"TypeScript","inResume":0,"inJD":7,"status":"Missing"},{"keyword":"Agile","inResume":1,"inJD":3,"status":"Low"}],"missingKeywords":[{"keyword":"TypeScript","suggestion":"Add TypeScript to your Skills section and mention it in project descriptions"},{"keyword":"Docker","suggestion":"Mention Docker in Work Experience: containerized applications using Docker"}],"recommendations":["rec1","rec2","rec3","rec4","rec5"]}`,
    { ...options, maxTokens: 2000 }
  ),

  /** OCR text extraction (returns cleaned text from raw OCR output) */
  cleanOCRText: (rawText, options = {}) => generateText(
    'You are a text editor. Clean OCR-extracted text — fix spacing, line breaks, obvious OCR errors. Return only the cleaned text.',
    rawText,
    options
  ),

  /** Generic tool handler — fallback for any tool */
  generic: (toolName, input, options = {}) => generateText(
    `You are an AI assistant for the ${toolName} tool. Provide helpful, accurate output.`,
    typeof input === 'string' ? input : JSON.stringify(input),
    options
  ),
};

module.exports = aiService;
