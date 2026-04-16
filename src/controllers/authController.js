'use strict';

/**
 * Auth Controller — signup, login, token refresh, password reset, profile.
 */

const crypto          = require('crypto');
const User            = require('../models/User');
const File            = require('../models/File');
const Job             = require('../models/Job');
const Subscription    = require('../models/Subscription');
const emailService    = require('../services/emailService');
const storageService  = require('../services/storageService');
const { successResponse, ApiError } = require('../utils/apiResponse');
const logger          = require('../utils/logger');

// ─── Cookie helpers ───────────────────────────────────────────────────────────

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
};

// ─── Signup ───────────────────────────────────────────────────────────────────

exports.signup = async (req, res) => {
  const { name, email, password } = req.body;

  const existing = await User.findByEmail(email);
  if (existing) throw new ApiError(409, 'An account with this email already exists');

  const user = await User.create({ name, email, password });

  // Create default free subscription
  await Subscription.create({ userId: user._id, plan: 'free' });

  // Send welcome email (non-blocking)
  emailService.sendWelcome(user).catch((err) =>
    logger.warn('Welcome email failed', { userId: user._id, error: err.message })
  );

  const accessToken  = user.generateAccessToken();
  const refreshToken = user.generateRefreshToken();

  // Persist refresh token
  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  return successResponse(res, {
    user: {
      id:    user._id,
      name:  user.name,
      email: user.email,
      plan:  user.plan,
      role:  user.role,
    },
    accessToken,
  }, 'Account created successfully', 201);
};

// ─── Login ────────────────────────────────────────────────────────────────────

exports.login = async (req, res) => {
  const { email, password } = req.body;

  // Explicitly select password (hidden by default in schema)
  const user = await User.findByEmail(email).select('+password');
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw new ApiError(401, 'Invalid email or password');

  const accessToken  = user.generateAccessToken();
  const refreshToken = user.generateRefreshToken();

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  return successResponse(res, {
    user: { id: user._id, name: user.name, email: user.email, plan: user.plan, role: user.role },
    accessToken,
  }, 'Logged in successfully');
};

// ─── Refresh token ────────────────────────────────────────────────────────────

exports.refreshToken = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) throw new ApiError(401, 'Refresh token missing');

  const jwt = require('jsonwebtoken');
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  const user = await User.findById(payload.id).select('+refreshToken');
  if (!user || user.refreshToken !== token) {
    throw new ApiError(401, 'Refresh token reuse detected — please login again');
  }

  // Rotate tokens
  const newAccessToken  = user.generateAccessToken();
  const newRefreshToken = user.generateRefreshToken();

  user.refreshToken = newRefreshToken;
  await user.save({ validateBeforeSave: false });

  res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTIONS);

  return successResponse(res, { accessToken: newAccessToken }, 'Token refreshed');
};

// ─── Logout ───────────────────────────────────────────────────────────────────

exports.logout = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (user) {
    user.refreshToken = undefined;
    await user.save({ validateBeforeSave: false });
  }

  res.clearCookie('refreshToken', { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  return successResponse(res, null, 'Logged out successfully');
};

// ─── Get current user ─────────────────────────────────────────────────────────

exports.getMe = async (req, res) => {
  const user = await User.findById(req.user._id);
  const subscription = await Subscription.findOne({ userId: user._id });

  return successResponse(res, {
    user: {
      id:              user._id,
      name:            user.name,
      email:           user.email,
      avatar:          user.avatar,
      plan:            user.plan,
      role:            user.role,
      isEmailVerified: user.isEmailVerified,
      createdAt:       user.createdAt,
    },
    subscription: subscription ? {
      plan:      subscription.plan,
      status:    subscription.status,
      endDate:   subscription.endDate,
      isActive:  subscription.isActive(),
    } : null,
  });
};

// ─── Update profile ───────────────────────────────────────────────────────────

exports.updateProfile = async (req, res) => {
  const { name, avatar } = req.body;
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { name, avatar },
    { new: true, runValidators: true }
  );
  return successResponse(res, { user: { id: user._id, name: user.name, email: user.email, avatar: user.avatar } }, 'Profile updated');
};

// ─── Change password ──────────────────────────────────────────────────────────

exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password');

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) throw new ApiError(400, 'Current password is incorrect');

  user.password = newPassword;
  await user.save();

  return successResponse(res, null, 'Password changed successfully');
};

// ─── Forgot password ──────────────────────────────────────────────────────────

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  const user = await User.findByEmail(email);

  // Always return success to prevent email enumeration
  if (!user) {
    return successResponse(res, null, 'If that email exists, a reset link has been sent');
  }

  const token  = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  user.resetPasswordToken  = crypto.createHash('sha256').update(token).digest('hex');
  user.resetPasswordExpiry = expiry;
  await user.save({ validateBeforeSave: false });

  await emailService.sendPasswordReset(user, token);

  return successResponse(res, null, 'Password reset link sent to your email');
};

// ─── Reset password ───────────────────────────────────────────────────────────

exports.resetPassword = async (req, res) => {
  const { token, password } = req.body;
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    resetPasswordToken:  hashedToken,
    resetPasswordExpiry: { $gt: new Date() },
  }).select('+resetPasswordToken +resetPasswordExpiry');

  if (!user) throw new ApiError(400, 'Reset link is invalid or has expired');

  user.password            = password;
  user.resetPasswordToken  = undefined;
  user.resetPasswordExpiry = undefined;
  user.refreshToken        = undefined;  // Invalidate all sessions
  await user.save();

  return successResponse(res, null, 'Password reset successfully. Please login with your new password.');
};

// ─── Favorites ────────────────────────────────────────────────────────────────

exports.getFavorites = async (req, res) => {
  const user = await User.findById(req.user._id).select('favorites');
  return successResponse(res, { favorites: user.favorites || [] });
};

exports.addFavorite = async (req, res) => {
  const { slug, category } = req.body;
  if (!slug || !category) throw new ApiError(400, 'slug and category are required');

  const user = await User.findById(req.user._id);
  const exists = user.favorites.some((f) => f.slug === slug);
  if (!exists) {
    user.favorites.push({ slug, category, addedAt: new Date() });
    await user.save({ validateBeforeSave: false });
  }

  return successResponse(res, { favorites: user.favorites }, 'Added to favorites');
};

exports.removeFavorite = async (req, res) => {
  const { slug } = req.params;
  await User.findByIdAndUpdate(req.user._id, { $pull: { favorites: { slug } } });
  return successResponse(res, null, 'Removed from favorites');
};

// ─── Delete account ───────────────────────────────────────────────────────────

exports.deleteAccount = async (req, res) => {
  const userId = req.user._id;

  // Delete all files from cloud storage
  const files = await File.find({ userId });
  await Promise.all(
    files.map(async (file) => {
      if (file.publicId) await storageService.delete(file.publicId).catch(() => {});
      if (file.processedPublicId) await storageService.delete(file.processedPublicId).catch(() => {});
    })
  );

  // Delete all user data
  await Promise.all([
    File.deleteMany({ userId }),
    Job.deleteMany({ userId }),
    Subscription.deleteOne({ userId }),
  ]);
  await User.findByIdAndDelete(userId);

  res.clearCookie('refreshToken', { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  return successResponse(res, null, 'Account deleted successfully');
};

// ─── OAuth helpers ────────────────────────────────────────────────────────────

async function handleOAuthUser(email, name, avatar, res) {
  let user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    user = await User.create({
      name: name || email.split('@')[0],
      email: email.toLowerCase(),
      password: crypto.randomBytes(32).toString('hex'),
      avatar,
      isEmailVerified: true,
    });
  }
  const accessToken  = user.generateAccessToken();
  const refreshToken = user.generateRefreshToken();
  user.refreshToken  = refreshToken;
  await user.save({ validateBeforeSave: false });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);
  return accessToken;
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

exports.googleAuth = (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=google_not_configured`);
  }
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${process.env.BACKEND_URL}/api/v1/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};

exports.googleCallback = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=oauth_cancelled`);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${process.env.BACKEND_URL}/api/v1/auth/google/callback`,
        grant_type:    'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token from Google');

    const userRes  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();
    if (!googleUser.email) throw new Error('No email from Google');

    const accessToken = await handleOAuthUser(googleUser.email, googleUser.name, googleUser.picture, res);
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${accessToken}`);
  } catch (err) {
    logger.error('Google OAuth error', { error: err.message });
    res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=oauth_failed`);
  }
};

// ─── Facebook OAuth ───────────────────────────────────────────────────────────

exports.facebookAuth = (req, res) => {
  if (!process.env.FACEBOOK_APP_ID) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=facebook_not_configured`);
  }
  const params = new URLSearchParams({
    client_id:     process.env.FACEBOOK_APP_ID,
    redirect_uri:  `${process.env.BACKEND_URL}/api/v1/auth/facebook/callback`,
    scope:         'email,public_profile',
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params}`);
};

exports.facebookCallback = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=oauth_cancelled`);

    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?${new URLSearchParams({
        client_id:     process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri:  `${process.env.BACKEND_URL}/api/v1/auth/facebook/callback`,
        code,
      })}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token from Facebook');

    const userRes = await fetch(
      `https://graph.facebook.com/me?fields=name,email,picture&access_token=${tokenData.access_token}`
    );
    const fbUser = await userRes.json();
    // Facebook may not return email if user hasn't verified it
    if (!fbUser.email) {
      return res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=facebook_no_email`);
    }

    const accessToken = await handleOAuthUser(fbUser.email, fbUser.name, fbUser.picture?.data?.url, res);
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${accessToken}`);
  } catch (err) {
    logger.error('Facebook OAuth error', { error: err.message });
    res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=oauth_failed`);
  }
};
