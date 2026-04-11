'use strict';

const mongoose = require('mongoose');

// ─── Plan feature definitions ─────────────────────────────────────────────────
const PLAN_FEATURES = {
  free: {
    maxFileSize: 50 * 1024 * 1024,   // 50 MB in bytes
    dailyLimit: 50,
    monthlyLimit: 500,
  },
  pro: {
    maxFileSize: 200 * 1024 * 1024,  // 200 MB in bytes
    dailyLimit: 100,
    monthlyLimit: 1000,
  },
  premium: {
    maxFileSize: 500 * 1024 * 1024,  // 500 MB in bytes
    dailyLimit: -1,                   // -1 represents unlimited
    monthlyLimit: -1,
  },
};

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      unique: true, // One active subscription record per user
      index: true,
    },
    plan: {
      type: String,
      enum: ['free', 'pro', 'premium'],
      default: 'free',
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled', 'pending'],
      default: 'active',
    },
    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
      default: Date.now,
    },
    // null for the free plan; set to a specific date for paid plans
    endDate: {
      type: Date,
      default: null,
    },
    autoRenew: {
      type: Boolean,
      default: false,
    },
    paymentGateway: {
      type: String,
      enum: ['razorpay', 'stripe', 'none'],
      default: 'none',
    },
    // External subscription ID from Razorpay / Stripe
    gatewaySubscriptionId: {
      type: String,
    },
    features: {
      maxFileSize: { type: Number },   // bytes
      dailyLimit: { type: Number },    // -1 = unlimited
      monthlyLimit: { type: Number },  // -1 = unlimited
    },
  },
  {
    timestamps: true,
  }
);

// ─── Pre-save hook: keep features in sync with the selected plan ──────────────
subscriptionSchema.pre('save', function (next) {
  if (this.isModified('plan') || this.isNew) {
    const planFeatures = PLAN_FEATURES[this.plan];
    if (planFeatures) {
      this.features = { ...planFeatures };
    }
  }
  next();
});

// ─── Instance method: check whether the subscription is currently active ──────
subscriptionSchema.methods.isActive = function () {
  if (this.status !== 'active') return false;

  // Free plan never expires
  if (!this.endDate) return true;

  // Paid plans expire at endDate
  return new Date() < this.endDate;
};

const Subscription = mongoose.model('Subscription', subscriptionSchema);

// Export the feature map so other modules can reference plan limits directly
Subscription.PLAN_FEATURES = PLAN_FEATURES;

module.exports = Subscription;
