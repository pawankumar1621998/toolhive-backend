'use strict';

/**
 * Subscription + Payment Controller — Razorpay & Stripe integration.
 */

const Razorpay    = require('razorpay');
const crypto      = require('crypto');
const Subscription = require('../models/Subscription');
const Payment     = require('../models/Payment');
const User        = require('../models/User');
const emailService = require('../services/emailService');
const { successResponse, ApiError } = require('../utils/apiResponse');
const logger      = require('../utils/logger');

// ─── Plan pricing (in smallest unit — paise for INR, cents for USD) ───────────

const PLAN_PRICES = {
  razorpay: {
    pro:     { 1: 49900,  3: 129900, 12: 399900  }, // ₹499 / ₹1299 / ₹3999
    premium: { 1: 99900,  3: 249900, 12: 799900  }, // ₹999 / ₹2499 / ₹7999
  },
  stripe: {
    pro:     { 1: 999,   3: 2499,  12: 7999   },  // $9.99 / $24.99 / $79.99
    premium: { 1: 1999,  3: 4999,  12: 15999  },
  },
};

// ─── Razorpay client ──────────────────────────────────────────────────────────

let razorpayClient = null;

function getRazorpay() {
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

// ─── Get subscription info ────────────────────────────────────────────────────

exports.getSubscription = async (req, res) => {
  const subscription = await Subscription.findOne({ userId: req.user._id });
  if (!subscription) throw new ApiError(404, 'Subscription not found');

  return successResponse(res, {
    subscription: {
      plan:      subscription.plan,
      status:    subscription.status,
      isActive:  subscription.isActive(),
      startDate: subscription.startDate,
      endDate:   subscription.endDate,
      features:  subscription.features,
    },
  });
};

// ─── Get all plans ────────────────────────────────────────────────────────────

exports.getPlans = async (req, res) => {
  return successResponse(res, {
    plans: [
      {
        id:          'free',
        name:        'Free',
        price:       0,
        currency:    'INR',
        features:    { maxFileSize: 50, dailyLimit: 10, monthlyLimit: 100, tools: 'basic' },
        highlighted: false,
      },
      {
        id:          'pro',
        name:        'Pro',
        price:       499,
        currency:    'INR',
        priceMonthly: 499,
        features:    { maxFileSize: 200, dailyLimit: 100, monthlyLimit: 1000, tools: 'all', priority: true },
        highlighted: true,
      },
      {
        id:          'premium',
        name:        'Premium',
        price:       999,
        currency:    'INR',
        priceMonthly: 999,
        features:    { maxFileSize: 500, dailyLimit: -1, monthlyLimit: -1, tools: 'all+ai', priority: true, api: true },
        highlighted: false,
      },
    ],
  });
};

// ─── Create Razorpay order ────────────────────────────────────────────────────

exports.createRazorpayOrder = async (req, res) => {
  const { plan, duration = 1 } = req.body;
  if (!['pro', 'premium'].includes(plan)) throw new ApiError(400, 'Invalid plan');

  const amount = PLAN_PRICES.razorpay[plan][duration];
  if (!amount) throw new ApiError(400, 'Invalid duration');

  const order = await getRazorpay().orders.create({
    amount,
    currency: 'INR',
    receipt:  `th_${req.user._id}_${Date.now()}`,
    notes:    { userId: req.user._id.toString(), plan, duration: duration.toString() },
  });

  // Save pending payment record
  await Payment.create({
    userId:         req.user._id,
    amount,
    currency:       'INR',
    gateway:        'razorpay',
    gatewayOrderId: order.id,
    plan,
    duration,
    status:         'created',
  });

  return successResponse(res, {
    orderId:   order.id,
    amount,
    currency:  'INR',
    key:       process.env.RAZORPAY_KEY_ID,
    plan,
    duration,
  }, 'Order created', 201);
};

// ─── Verify Razorpay payment ──────────────────────────────────────────────────

exports.verifyRazorpayPayment = async (req, res) => {
  const { orderId, paymentId, signature } = req.body;

  // Verify HMAC signature
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (expectedSignature !== signature) {
    throw new ApiError(400, 'Payment verification failed — invalid signature');
  }

  const payment = await Payment.findOne({ gatewayOrderId: orderId, userId: req.user._id });
  if (!payment) throw new ApiError(404, 'Payment record not found');

  // Update payment record
  payment.gatewayPaymentId = paymentId;
  payment.gatewaySignature = signature;
  payment.status           = 'success';
  await payment.save();

  // Activate subscription
  const subscription = await activateSubscription(req.user._id, payment.plan, payment.duration, payment._id, 'razorpay');

  // Update user's plan
  await User.findByIdAndUpdate(req.user._id, { plan: payment.plan });

  // Send confirmation email
  const user = await User.findById(req.user._id);
  emailService.sendSubscriptionConfirmation(user, subscription, payment).catch((err) =>
    logger.warn('Subscription confirmation email failed', { error: err.message })
  );

  return successResponse(res, {
    subscription: { plan: subscription.plan, endDate: subscription.endDate },
    payment:      { id: payment._id, amount: payment.amount, status: 'success' },
  }, 'Payment verified and subscription activated');
};

// ─── Razorpay webhook (server-to-server verification) ────────────────────────

exports.razorpayWebhook = async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(200).json({ received: true });

  const signature = req.headers['x-razorpay-signature'];
  const body      = JSON.stringify(req.body);
  const expected  = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

  if (expected !== signature) {
    logger.warn('Invalid Razorpay webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const { event, payload } = req.body;
  logger.info('Razorpay webhook received', { event });

  if (event === 'payment.failed') {
    const orderId = payload?.payment?.entity?.order_id;
    if (orderId) {
      await Payment.findOneAndUpdate({ gatewayOrderId: orderId }, { status: 'failed' });
    }
  }

  return res.status(200).json({ received: true });
};

// ─── Cancel subscription ──────────────────────────────────────────────────────

exports.cancelSubscription = async (req, res) => {
  const subscription = await Subscription.findOne({ userId: req.user._id });
  if (!subscription || subscription.plan === 'free') {
    throw new ApiError(400, 'No active paid subscription to cancel');
  }

  subscription.autoRenew = false;
  subscription.status    = 'cancelled';
  await subscription.save();

  // Downgrade user plan to free at end date (handled by cron)
  logger.info('Subscription cancelled', { userId: req.user._id, plan: subscription.plan });

  return successResponse(res, {
    message:  'Subscription cancelled. You will have access until the end of your billing period.',
    endDate:  subscription.endDate,
  });
};

// ─── Helper: activate subscription ───────────────────────────────────────────

async function activateSubscription(userId, plan, durationMonths, paymentId, gateway) {
  const startDate = new Date();
  const endDate   = new Date();
  endDate.setMonth(endDate.getMonth() + parseInt(durationMonths));

  const subscription = await Subscription.findOneAndUpdate(
    { userId },
    {
      plan,
      status:       'active',
      startDate,
      endDate,
      autoRenew:    false,
      paymentGateway: gateway,
    },
    { new: true, upsert: true }
  );

  if (paymentId) {
    await Payment.findByIdAndUpdate(paymentId, { subscriptionId: subscription._id });
  }

  return subscription;
}
