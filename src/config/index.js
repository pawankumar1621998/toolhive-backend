/**
 * Centralised configuration module.
 *
 * All environment variables are read here with safe defaults so every other
 * module can `require('./config')` instead of accessing process.env directly.
 * This makes it easy to validate, override, or mock config in tests.
 */

require('dotenv').config();

const config = {
  // ─── Server ────────────────────────────────────────────────────────────────
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // ─── Database ──────────────────────────────────────────────────────────────
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/toolhive',

  // ─── Redis ─────────────────────────────────────────────────────────────────
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // ─── JWT ───────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'change_me_access_secret',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'change_me_refresh_secret',
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || '15m',
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || '7d',

  // ─── Cloudinary ────────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

  // ─── AI Providers ──────────────────────────────────────────────────────────
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',

  // ─── Payments ──────────────────────────────────────────────────────────────
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',

  // ─── Email ─────────────────────────────────────────────────────────────────
  EMAIL_HOST: process.env.EMAIL_HOST || 'smtp.gmail.com',
  EMAIL_PORT: parseInt(process.env.EMAIL_PORT, 10) || 587,
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASS: process.env.EMAIL_PASS || '',

  // ─── CORS ──────────────────────────────────────────────────────────────────
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
};

module.exports = config;
