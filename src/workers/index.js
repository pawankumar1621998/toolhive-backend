'use strict';

/**
 * Worker entry point — starts all BullMQ workers in a single process.
 * Run via: npm run worker
 */

require('dotenv').config();

require('./pdfWorker');
require('./imageWorker');
require('./aiWorker');
