'use strict';

const { Router }         = require('express');
const subController      = require('../controllers/subscriptionController');
const { authenticate }   = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = Router();

// Public
router.get('/plans', subController.getPlans);

// Razorpay webhook (raw body needed — configured in app.js)
router.post('/webhook/razorpay', subController.razorpayWebhook);

// Protected
router.use(authenticate);

router.get('/',                                    subController.getSubscription);
router.post('/order/razorpay',
  validate(schemas.createOrder),
  subController.createRazorpayOrder
);
router.post('/verify/razorpay',
  validate(schemas.verifyPayment),
  subController.verifyRazorpayPayment
);
router.post('/cancel',                             subController.cancelSubscription);

module.exports = router;
