'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ─── Helper: pull the Bearer token out of the Authorization header ────────────
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7); // Everything after "Bearer "
  }
  return null;
}

// ─── authenticate ─────────────────────────────────────────────────────────────
// Requires a valid access JWT. Attaches the full user document to req.user.
// Returns 401 on any token problem.
const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token is missing',
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch (err) {
      // Distinguish between expired tokens and malformed tokens so clients
      // know whether to attempt a token refresh.
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }

    // Fetch fresh user data from DB so revoked accounts are rejected
    const user = await User.findById(payload.id).select('-password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

// ─── optionalAuth ─────────────────────────────────────────────────────────────
// Like authenticate but never blocks the request.  Routes that work for both
// guests and logged-in users should use this.  req.user will be null for guests.
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      req.user = null;
      return next();
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch {
      // Any token error → treat as guest
      req.user = null;
      return next();
    }

    const user = await User.findById(payload.id).select('-password');
    req.user = user || null;
    next();
  } catch (err) {
    // Even on unexpected errors, don't block the request
    req.user = null;
    next();
  }
};

// ─── authorizeRoles ───────────────────────────────────────────────────────────
// Factory middleware: only allows users whose role is in the provided list.
// Must be used AFTER authenticate so that req.user is populated.
//
// Usage:
//   router.delete('/users/:id', authenticate, authorizeRoles('admin'), handler)
const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role(s): ${roles.join(', ')}`,
      });
    }

    next();
  };
};

module.exports = { authenticate, optionalAuth, authorizeRoles };
