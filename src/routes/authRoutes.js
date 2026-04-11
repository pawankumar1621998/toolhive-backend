'use strict';

const { Router } = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiter');

const router = Router();

// Public routes
router.post('/signup',          authLimiter, validate(schemas.signup),          authController.signup);
router.post('/login',           authLimiter, validate(schemas.login),           authController.login);
router.post('/refresh-token',   authLimiter,                                    authController.refreshToken);
router.post('/forgot-password', authLimiter, validate(schemas.forgotPassword),  authController.forgotPassword);
router.post('/reset-password',  authLimiter, validate(schemas.resetPassword),   authController.resetPassword);

// Protected routes
router.post('/logout',           authenticate, authController.logout);
router.get( '/me',               authenticate, authController.getMe);
router.patch('/profile',         authenticate, validate(schemas.updateProfile),  authController.updateProfile);
router.patch('/change-password', authenticate, validate(schemas.changePassword), authController.changePassword);
router.delete('/account',        authenticate, authController.deleteAccount);

// Favorites
router.get('/favorites',            authenticate, authController.getFavorites);
router.post('/favorites',           authenticate, authController.addFavorite);
router.delete('/favorites/:slug',   authenticate, authController.removeFavorite);

module.exports = router;
