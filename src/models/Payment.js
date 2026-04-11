'use strict';

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
    },
    // Amount in the smallest currency unit (paise for INR, cents for USD)
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
    },
    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
    },
    gateway: {
      type: String,
      enum: ['razorpay', 'stripe'],
      required: [true, 'Payment gateway is required'],
    },
    // Order ID returned by the gateway when the order is created
    gatewayOrderId: {
      type: String,
      required: [true, 'Gateway order ID is required'],
    },
    // Payment ID returned after the user completes payment
    gatewayPaymentId: {
      type: String,
    },
    // HMAC signature for Razorpay webhook/callback verification
    gatewaySignature: {
      type: String,
    },
    plan: {
      type: String,
      enum: ['pro', 'premium'],
      required: [true, 'Plan is required'],
    },
    // Subscription duration in months (1, 6, 12, etc.)
    duration: {
      type: Number,
    },
    status: {
      type: String,
      enum: ['created', 'pending', 'success', 'failed', 'refunded'],
      default: 'created',
    },
    // Arbitrary extra data (webhook payload, tax info, etc.)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

const Payment = mongoose.model('Payment', paymentSchema);
module.exports = Payment;
