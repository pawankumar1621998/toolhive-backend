/**
 * MongoDB connection module.
 *
 * Uses Mongoose to establish a connection to the database defined in
 * MONGODB_URI. Calling connectDB() is idempotent – Mongoose will reuse an
 * existing connection if one is already open.
 */

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { MONGODB_URI } = require('./index');

/**
 * Connect to MongoDB using the URI from environment config.
 *
 * @returns {Promise<typeof mongoose>} Resolves to the mongoose instance once
 *   the connection is established.
 * @throws {Error} Re-throws any connection error after logging it, so the
 *   caller (server.js) can decide whether to abort the process.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000, // give up after 30 s
      socketTimeoutMS: 45000,          // close sockets after 45 s of inactivity
      connectTimeoutMS: 30000,
    });

    logger.info(`MongoDB connected: ${conn.connection.host}`);

    // Surface further lifecycle events after the initial connection.
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected. Attempting to reconnect…');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected.');
    });

    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB connection error: ${err.message}`);
    });

    return conn;
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    throw err;
  }
};

module.exports = { connectDB };
