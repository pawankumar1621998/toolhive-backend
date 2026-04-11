/**
 * General-purpose utility helpers used across the application.
 */

const path = require('path');
const crypto = require('crypto');

// ─── OTP ─────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random numeric OTP string.
 *
 * Uses `crypto.randomInt` to avoid modulo bias.
 *
 * @param {number} [length=6] - Number of digits in the OTP.
 * @returns {string} Zero-padded numeric string of the requested length.
 *
 * @example
 * generateOTP();      // '048271'
 * generateOTP(4);     // '3819'
 */
const generateOTP = (length = 6) => {
  const max = Math.pow(10, length);   // exclusive upper bound
  const otp = crypto.randomInt(0, max);
  // Pad with leading zeros so the result always has `length` digits.
  return String(otp).padStart(length, '0');
};

// ─── File size formatting ─────────────────────────────────────────────────────

/**
 * Convert a raw byte count into a human-readable string.
 *
 * @param {number} bytes      - Size in bytes.
 * @param {number} [decimals=2] - Number of decimal places.
 * @returns {string} Formatted string such as "1.23 MB".
 *
 * @example
 * formatBytes(0);          // '0 Bytes'
 * formatBytes(1024);       // '1.00 KB'
 * formatBytes(1048576);    // '1.00 MB'
 */
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// ─── Slugify ──────────────────────────────────────────────────────────────────

/**
 * Convert a plain-text string into a URL-safe slug.
 *
 * Strips accents, lowercases, replaces non-alphanumeric sequences with hyphens,
 * and trims leading/trailing hyphens.
 *
 * @param {string} text - Input text to slugify.
 * @returns {string} URL-safe lowercase slug.
 *
 * @example
 * slugify('Hello World!');            // 'hello-world'
 * slugify('  Café & Bar -- 2024  ');  // 'cafe-bar-2024'
 */
const slugify = (text) => {
  return text
    .toString()
    .normalize('NFD')                       // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')        // strip diacritic marks
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')          // remove remaining non-slug chars
    .replace(/[\s_-]+/g, '-')              // collapse whitespace/underscores to hyphen
    .replace(/^-+|-+$/g, '');             // trim leading/trailing hyphens
};

// ─── Unique filename ──────────────────────────────────────────────────────────

/**
 * Generate a unique filename by injecting a timestamp and random hex suffix
 * before the extension.  Safe for use as a Cloudinary public_id or on disk.
 *
 * @param {string} originalName - Original filename (e.g. "my photo.jpg").
 * @returns {string} Unique filename (e.g. "my-photo-1712345678900-a3f9.jpg").
 *
 * @example
 * generateUniqueFilename('resume.pdf');
 * // → 'resume-1712345678900-b8d2.pdf'
 */
const generateUniqueFilename = (originalName) => {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  return `${slugify(base)}-${timestamp}-${randomSuffix}${ext}`;
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Calculate a future expiry date offset from now.
 *
 * @param {number} days - Number of days from the current moment.
 * @returns {Date} A new Date object set to `days` days in the future.
 *
 * @example
 * calculateExpiryDate(7);  // Date 7 days from now
 */
const calculateExpiryDate = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

/**
 * Determine whether a given date is in the past.
 *
 * @param {Date|string|number} date - The date to check.
 * @returns {boolean} `true` if the date has already passed, `false` otherwise.
 *
 * @example
 * isExpired(new Date('2000-01-01'));  // true
 * isExpired(new Date('2099-01-01'));  // false
 */
const isExpired = (date) => {
  return new Date(date) < new Date();
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateOTP,
  formatBytes,
  slugify,
  generateUniqueFilename,
  calculateExpiryDate,
  isExpired,
};
