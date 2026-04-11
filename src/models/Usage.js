'use strict';

const mongoose = require('mongoose');

const usageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    // Store date-only as a Date object at midnight UTC so range queries are easy
    date: {
      type: Date,
      required: [true, 'Date is required'],
      index: true,
    },
    // Specific tool name, e.g. 'pdf-compress', 'bg-remove'
    tool: {
      type: String,
    },
    // Broad category of the tool
    category: {
      type: String,
    },
    // Number of times this tool was used on this date
    count: {
      type: Number,
      default: 1,
    },
    // Total bytes processed through this tool on this date
    bytesProcessed: {
      type: Number,
      default: 0,
    },
    // "YYYY-MM" string for efficient monthly roll-up queries
    month: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Compound unique index: one record per (user, date, tool) ─────────────────
usageSchema.index({ userId: 1, date: 1, tool: 1 }, { unique: true });

// ─── Helper: return a Date at midnight UTC for any given date ─────────────────
function todayMidnightUTC() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

// ─── Helper: return "YYYY-MM" string for any Date ────────────────────────────
function toMonthString(date) {
  const d = date || new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

// ─── Static: sum of all tool uses for a user on today's date ─────────────────
usageSchema.statics.getTodayUsage = async function (userId) {
  const today = todayMidnightUTC();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const result = await this.aggregate([
    {
      $match: {
        userId: typeof userId === 'string'
          ? new mongoose.Types.ObjectId(userId)
          : userId,
        date: { $gte: today, $lt: tomorrow },
      },
    },
    {
      $group: {
        _id: null,
        totalCount: { $sum: '$count' },
      },
    },
  ]);

  return result.length > 0 ? result[0].totalCount : 0;
};

// ─── Static: sum of all tool uses for a user in a given month ────────────────
// month: "YYYY-MM" string, e.g. "2025-01"
usageSchema.statics.getMonthUsage = async function (userId, month) {
  const result = await this.aggregate([
    {
      $match: {
        userId: typeof userId === 'string'
          ? new mongoose.Types.ObjectId(userId)
          : userId,
        month,
      },
    },
    {
      $group: {
        _id: null,
        totalCount: { $sum: '$count' },
      },
    },
  ]);

  return result.length > 0 ? result[0].totalCount : 0;
};

// ─── Static: upsert (increment) usage for today ──────────────────────────────
// Uses findOneAndUpdate with $inc so it is safe for concurrent requests.
usageSchema.statics.incrementUsage = async function (
  userId,
  tool,
  category,
  bytes = 0
) {
  const today = todayMidnightUTC();
  const month = toMonthString(today);

  const uid =
    typeof userId === 'string'
      ? new mongoose.Types.ObjectId(userId)
      : userId;

  return this.findOneAndUpdate(
    { userId: uid, date: today, tool },
    {
      $inc: { count: 1, bytesProcessed: bytes },
      $setOnInsert: { userId: uid, date: today, tool, category, month },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

const Usage = mongoose.model('Usage', usageSchema);
module.exports = Usage;
