/**
 * Application-wide Winston logger.
 *
 * Outputs:
 *  - Console  – colourised, human-readable (all levels in development, warn+
 *               in production).
 *  - File     – logs/error-%DATE%.log  (error level only, kept for 30 days)
 *  - File     – logs/combined-%DATE%.log (all levels, kept for 14 days)
 *
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info('Server started');
 *   logger.error('Something broke', { meta: 'value' });
 */

const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const { combine, timestamp, colorize, printf, json, errors } = format;

// ─── Shared formatters ───────────────────────────────────────────────────────

/** Human-readable format used for the console transport. */
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return stack
      ? `[${ts}] ${level}: ${message}\n${stack}${metaStr}`
      : `[${ts}] ${level}: ${message}${metaStr}`;
  })
);

/** Structured JSON format used for file transports. */
const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  json()
);

// ─── File transports ─────────────────────────────────────────────────────────

const logsDir = path.join(process.cwd(), 'logs');

const errorFileTransport = new DailyRotateFile({
  level: 'error',
  dirname: logsDir,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  format: fileFormat,
});

const combinedFileTransport = new DailyRotateFile({
  dirname: logsDir,
  filename: 'combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  format: fileFormat,
});

errorFileTransport.on('rotate', (oldFilename, newFilename) => {
  // Notify when log rotation happens (visible in console/combined log).
  logger.info(`Error log rotated: ${oldFilename} → ${newFilename}`); // eslint-disable-line no-use-before-define
});

// ─── Logger instance ─────────────────────────────────────────────────────────

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  exitOnError: false,
  transports: [
    new transports.Console({ format: consoleFormat }),
    errorFileTransport,
    combinedFileTransport,
  ],
});

module.exports = logger;
