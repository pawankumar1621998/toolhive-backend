'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Stored as bcrypt hash; minlength applies to the raw value before hashing
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // Never return password in queries by default
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    avatar: {
      type: String, // Cloudinary or external URL
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerifyToken: {
      type: String,
      select: false,
    },
    emailVerifyExpiry: {
      type: Date,
      select: false,
    },
    resetPasswordToken: {
      type: String,
      select: false,
    },
    resetPasswordExpiry: {
      type: Date,
      select: false,
    },
    refreshToken: {
      type: String,
      select: false,
    },
    plan: {
      type: String,
      enum: ['free', 'pro', 'premium'],
      default: 'free',
    },
    favorites: [
      {
        slug:     { type: String, required: true },
        category: { type: String, required: true },
        addedAt:  { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// ─── Pre-save hook: hash password only when it is new or modified ─────────────
userSchema.pre('save', async function (next) {
  // Skip hashing if password field was not touched
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Instance method: compare a plain-text candidate against stored hash ──────
userSchema.methods.comparePassword = async function (candidatePassword) {
  // `this.password` may be undefined if the document was loaded without
  // selecting the password field — callers must use .select('+password')
  return bcrypt.compare(candidatePassword, this.password);
};

// ─── Instance method: issue a short-lived access JWT ─────────────────────────
userSchema.methods.generateAccessToken = function () {
  return jwt.sign(
    {
      id: this._id,
      email: this.email,
      role: this.role,
      plan: this.plan,
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' }
  );
};

// ─── Instance method: issue a long-lived refresh JWT ─────────────────────────
userSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    { id: this._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

// ─── Static method: look up a user by email (case-insensitive via schema) ─────
userSchema.statics.findByEmail = function (email) {
  return this.findOne({ email: email.toLowerCase().trim() });
};

const User = mongoose.model('User', userSchema);
module.exports = User;
