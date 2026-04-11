'use strict';

/**
 * Image Worker — processes BullMQ jobs from the 'image-processing' queue.
 */

require('dotenv').config();
require('../config/database').connectDB();

const { Worker } = require('bullmq');
const { redisClient } = require('../config/redis');
const Job            = require('../models/Job');
const File           = require('../models/File');
const storageService = require('../services/storageService');
const logger         = require('../utils/logger');

async function processImageJob(job) {
  const { tool, fileId, userId, options } = job.data;
  const startTime = Date.now();

  await Job.findOneAndUpdate(
    { jobId: job.id },
    { status: 'processing', startedAt: new Date(), progress: 10 }
  );
  await job.updateProgress(10);

  let outputData;

  try {
    switch (tool) {
      case 'compress':
      case 'image-compress':        // legacy alias
        outputData = await compressImage(job, fileId, options);
        break;
      case 'resize':
      case 'image-resize':          // legacy alias
        outputData = await resizeImage(job, fileId, options);
        break;
      case 'convert':
      case 'image-convert':         // legacy alias
        outputData = await convertImage(job, fileId, options);
        break;
      case 'remove-background':
      case 'bg-remove':             // legacy alias
        outputData = await removeBackground(job, fileId, options);
        break;
      case 'crop':
      case 'image-crop':            // legacy alias
        outputData = await cropImage(job, fileId, options);
        break;
      case 'rotate':
      case 'image-rotate':          // legacy alias
        outputData = await rotateImage(job, fileId, options);
        break;
      case 'gif-maker':
        outputData = await makeGif(job, fileId, options);
        break;
      case 'watermark':
        outputData = await addWatermark(job, fileId, options);
        break;
      case 'upscale':
        outputData = await upscaleImage(job, fileId, options);
        break;
      case 'thumbnail-creator':
        outputData = await createThumbnail(job, fileId, options);
        break;
      case 'image-to-pdf':
        outputData = await imageToPdf(job, fileId, options);
        break;
      case 'qr-code':
        outputData = await generateQrCode(job, fileId, options);
        break;
      case 'meme':
        outputData = await makeMeme(job, fileId, options);
        break;
      default:
        throw new Error(`Unknown image tool: ${tool}`);
    }

    await job.updateProgress(100);
    const processingTime = Date.now() - startTime;

    await Job.findOneAndUpdate(
      { jobId: job.id },
      { status: 'completed', progress: 100, outputData, completedAt: new Date(), processingTime }
    );

    if (outputData.processedUrl) {
      await File.findByIdAndUpdate(fileId, {
        status: 'processed',
        processedUrl: outputData.processedUrl,
        processedPublicId: outputData.processedPublicId,
      });
    }

    logger.info('Image job completed', { jobId: job.id, tool, processingTime });
    return outputData;

  } catch (err) {
    await Job.findOneAndUpdate({ jobId: job.id }, { status: 'failed', error: err.message, completedAt: new Date() });
    await File.findByIdAndUpdate(fileId, { status: 'failed' });
    throw err;
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function compressImage(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  // Use Cloudinary's quality transformation
  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    quality: options.quality || 'auto:low',
    fetch_format: 'auto',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId, message: 'Image compressed via Cloudinary transformation' };
}

async function resizeImage(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const transformedUrl = storageService.resizeImage(
    file.publicId,
    options.width  || 800,
    options.height || 600,
    options.format || 'webp'
  );

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function convertImage(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    format: options.format || 'webp',
    quality: 'auto',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function removeBackground(job, fileId, options) {
  await job.updateProgress(20);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  await job.updateProgress(40);
  // Pass both publicId and the original Cloudinary URL so the storage service
  // can use it with external APIs (e.g. remove.bg) that accept a URL directly.
  const result = await storageService.removeBackground(file.publicId, file.url);
  await job.updateProgress(90);
  return { processedUrl: result.secure_url, processedPublicId: result.public_id };
}

async function cropImage(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    width: options.width, height: options.height,
    x: options.x, y: options.y,
    crop: 'crop',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function rotateImage(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    angle: options.angle || 90,
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function makeGif(job, fileId, options) {
  await job.updateProgress(50);
  // TODO: Use ffmpeg or Cloudinary video-to-GIF conversion
  return { processedUrl: null, message: 'GIF maker — connect FFmpeg to implement' };
}

async function addWatermark(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    overlay: { font_family: 'Arial', font_size: 40, text: options.text || 'ToolHive' },
    opacity: 50,
    gravity: 'south_east',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function upscaleImage(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  // Cloudinary AI upscale via enhance:upscale transformation
  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    effect: 'upscale',
    quality: 'auto',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function createThumbnail(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const width  = options.width  || 300;
  const height = options.height || 300;

  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    width, height,
    crop: 'thumb',
    gravity: 'auto',
    quality: 'auto',
    fetch_format: 'auto',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function imageToPdf(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  // Cloudinary can deliver any image as PDF via format transformation
  const transformedUrl = storageService.getTransformUrl(file.publicId, {
    format: 'pdf',
    quality: 'auto',
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

async function generateQrCode(job, fileId, options) {
  await job.updateProgress(20);
  // QR code generation — use a free QR API since it doesn't need a file input
  const text = options.text || options.url || 'https://toolhive.app';
  const size  = options.size || 300;

  // QR Server API — free, no key required
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&format=png`;

  await job.updateProgress(60);

  // Upload the generated QR code PNG to Cloudinary so we return a Cloudinary URL
  // global.fetch is available in Node 18+ (required by this project).
  // node-fetch v3 is ESM-only and cannot be require()'d — do not use it as fallback.
  const resp = await fetch(qrUrl);
  if (!resp.ok) throw new Error(`QR API error: ${resp.statusText}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const base64  = buffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;

  const { cloudinary } = require('../config/cloudinary');
  const uploadResult = await cloudinary.uploader.upload(dataUrl, {
    resource_type: 'image',
    folder: 'toolhive/processed',
    format: 'png',
  });

  await job.updateProgress(90);
  return { processedUrl: uploadResult.secure_url, processedPublicId: uploadResult.public_id };
}

async function makeMeme(job, fileId, options) {
  await job.updateProgress(30);
  const file = await File.findById(fileId);
  if (!file) throw new Error('File not found');

  const topText    = options.topText    || '';
  const bottomText = options.bottomText || '';
  const { cloudinary } = require('../config/cloudinary');

  // Build chained transformation array for Cloudinary
  const transformation = [];
  if (topText) {
    transformation.push({
      overlay: { font_family: 'Impact', font_size: 48, text: topText },
      gravity: 'north', y: 20, color: 'white',
    });
    transformation.push({ effect: 'outline:3', color: 'black' });
    transformation.push({ flags: 'layer_apply' });
  }
  if (bottomText) {
    transformation.push({
      overlay: { font_family: 'Impact', font_size: 48, text: bottomText },
      gravity: 'south', y: 20, color: 'white',
    });
    transformation.push({ effect: 'outline:3', color: 'black' });
    transformation.push({ flags: 'layer_apply' });
  }

  const transformedUrl = cloudinary.url(file.publicId, {
    secure: true,
    transformation: transformation.length > 0 ? transformation : [{ quality: 'auto' }],
  });

  await job.updateProgress(90);
  return { processedUrl: transformedUrl, processedPublicId: file.publicId };
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

const worker = new Worker('image-processing', processImageJob, {
  connection: redisClient,
  concurrency: 8,  // Images are lighter — higher concurrency
});

worker.on('completed', (job) => logger.info('Image job done', { jobId: job.id }));
worker.on('failed', (job, err) => logger.error('Image job failed', { jobId: job?.id, error: err.message }));
worker.on('error', (err) => logger.error('Image worker error', { error: err.message }));

logger.info('Image worker started — listening on queue: image-processing');

module.exports = worker;
