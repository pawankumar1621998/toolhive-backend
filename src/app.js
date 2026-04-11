/**
 * Express application factory.
 *
 * This module creates and configures the Express app without starting the
 * HTTP server. That separation makes it trivial to import the app in tests
 * without binding to a port.
 *
 * Middleware order matters:
 *   1. Security headers  (helmet)
 *   2. CORS
 *   3. Request parsing   (json, urlencoded)
 *   4. HTTP logging      (morgan)
 *   5. Rate limiting
 *   6. Routes
 *   7. 404 handler
 *   8. Global error handler   ← must be last
 */

'use strict';

// express-async-errors patches Express so async route handlers automatically
// pass rejected promises to the next() error handler – no try/catch needed.
require('express-async-errors');

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');

const apiRoutes = require('./routes/index');
const { errorHandler } = require('./middleware/errorHandler');
const { FRONTEND_URL, NODE_ENV } = require('./config/index');

const app = express();

// ─── 1. Security headers ──────────────────────────────────────────────────────

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// ─── 2. CORS ──────────────────────────────────────────────────────────────────

const allowedOrigins = [
  FRONTEND_URL,
  // Add staging / preview URLs here if needed.
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (server-to-server, curl, mobile apps).
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' is not allowed.`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

// ─── 3. Body parsing + cookies ────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── 4. HTTP request logging ──────────────────────────────────────────────────

// Use the compact 'dev' format in development; structured 'combined' in prod.
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── 5. Global rate limiting ──────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                  // requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
  },
});

app.use('/api', globalLimiter);

// ─── 6. API routes ────────────────────────────────────────────────────────────

app.use('/api/v1', apiRoutes);

// ─── 7. 404 handler ───────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    statusCode: 404,
    message: `Cannot ${req.method} ${req.originalUrl} – route not found.`,
  });
});

// ─── 8. Global error handler ──────────────────────────────────────────────────

app.use(errorHandler);

module.exports = app;
