'use strict';

/**
 * Storage Service — Cloudinary file management.
 *
 * Wraps Cloudinary upload / delete / transform operations.
 */

const { cloudinary } = require('../config/cloudinary');
const logger = require('../utils/logger');

const storageService = {

  /**
   * Upload a file buffer or local path to Cloudinary.
   *
   * @param {Buffer|string} source       - File buffer or local file path.
   * @param {object}        [options]    - Cloudinary upload options.
   * @returns {Promise<object>}          - Cloudinary upload result.
   */
  upload: async (source, options = {}) => {
    try {
      const result = await cloudinary.uploader.upload(source, {
        resource_type: 'auto',
        folder:        'toolhive/uploads',
        ...options,
      });
      logger.info('File uploaded to Cloudinary', { publicId: result.public_id });
      return result;
    } catch (err) {
      logger.error('Cloudinary upload failed', { error: err.message });
      throw err;
    }
  },

  /**
   * Upload from a URL (useful for processing already-hosted files).
   */
  uploadFromUrl: async (url, options = {}) => {
    return storageService.upload(url, options);
  },

  /**
   * Delete a file from Cloudinary.
   *
   * @param {string} publicId      - Cloudinary public_id.
   * @param {string} resourceType  - 'image' | 'video' | 'raw'
   */
  delete: async (publicId, resourceType = 'auto') => {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
      });
      logger.info('File deleted from Cloudinary', { publicId, result: result.result });
      return result;
    } catch (err) {
      logger.error('Cloudinary delete failed', { publicId, error: err.message });
      throw err;
    }
  },

  /**
   * Delete multiple files by public IDs.
   */
  deleteMany: async (publicIds, resourceType = 'image') => {
    if (!publicIds.length) return;
    try {
      const result = await cloudinary.api.delete_resources(publicIds, {
        resource_type: resourceType,
      });
      logger.info('Bulk delete from Cloudinary', { count: publicIds.length });
      return result;
    } catch (err) {
      logger.error('Cloudinary bulk delete failed', { error: err.message });
      throw err;
    }
  },

  /**
   * Generate a Cloudinary transformation URL.
   * Useful for on-the-fly image resizing, format conversion, etc.
   *
   * @param {string} publicId
   * @param {object} transformations - Cloudinary transformation options.
   */
  getTransformUrl: (publicId, transformations = {}) => {
    return cloudinary.url(publicId, {
      secure: true,
      ...transformations,
    });
  },

  /**
   * Resize and optimise an image.
   *
   * @param {string} publicId  - Cloudinary public_id of the source image.
   * @param {number} width
   * @param {number} height
   * @param {string} format    - Output format: 'webp' | 'jpeg' | 'png'
   */
  resizeImage: (publicId, width, height, format = 'webp') => {
    return storageService.getTransformUrl(publicId, {
      width,
      height,
      crop:    'fill',
      quality: 'auto',
      format,
      fetch_format: 'auto',
    });
  },

  /**
   * Remove background from an image.
   *
   * Strategy:
   *  1. remove.bg API    — if REMOVE_BG_API_KEY is set (50 free calls/month at remove.bg)
   *  2. Cloudinary AI    — if CLOUDINARY_BG_REMOVAL=true (requires paid Cloudinary add-on)
   *
   * @param {string} publicId  - Cloudinary public_id of the source image
   * @param {string} imageUrl  - Publicly accessible URL of the source image
   */
  removeBackground: async (publicId, imageUrl) => {
    // ── Option 1: remove.bg API ───────────────────────────────────────────────
    if (process.env.REMOVE_BG_API_KEY) {
      try {
        logger.info('Using remove.bg for background removal', { publicId });

        const response = await fetch('https://api.remove.bg/v1.0/removebg', {
          method: 'POST',
          headers: {
            'X-Api-Key':    process.env.REMOVE_BG_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image_url: imageUrl, size: 'auto' }),
        });

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          throw new Error(`remove.bg: ${errBody.errors?.[0]?.title || response.statusText}`);
        }

        // Upload the transparent PNG to Cloudinary for storage + CDN delivery
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64  = buffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;

        const uploadResult = await cloudinary.uploader.upload(dataUrl, {
          resource_type: 'image',
          folder:        'toolhive/processed',
          format:        'png',
        });

        logger.info('Background removed via remove.bg', { newPublicId: uploadResult.public_id });
        return uploadResult;
      } catch (err) {
        logger.error('remove.bg failed', { error: err.message });
        throw err;
      }
    }

    // ── Option 2: Cloudinary AI (requires paid Background Removal add-on) ─────
    if (process.env.CLOUDINARY_BG_REMOVAL === 'true') {
      try {
        const sourceUrl = imageUrl ||
          `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${publicId}`;
        const result = await cloudinary.uploader.upload(sourceUrl, {
          effect:        'background_removal',
          resource_type: 'image',
          folder:        'toolhive/processed',
        });
        return result;
      } catch (err) {
        logger.error('Cloudinary background removal failed', { publicId, error: err.message });
        throw err;
      }
    }

    // ── No provider configured ────────────────────────────────────────────────
    throw new Error(
      'Background removal not configured. ' +
      'Add REMOVE_BG_API_KEY to .env (free API key at remove.bg).'
    );
  },

  /**
   * Get file info / metadata from Cloudinary.
   */
  getInfo: async (publicId, resourceType = 'image') => {
    try {
      return await cloudinary.api.resource(publicId, { resource_type: resourceType });
    } catch (err) {
      logger.error('Cloudinary get info failed', { publicId, error: err.message });
      throw err;
    }
  },

  /**
   * List files in a Cloudinary folder (for admin/cleanup).
   */
  listFolder: async (folder, maxResults = 50) => {
    try {
      return await cloudinary.api.resources({
        type:         'upload',
        prefix:       folder,
        max_results:  maxResults,
        resource_type: 'auto',
      });
    } catch (err) {
      logger.error('Cloudinary list failed', { folder, error: err.message });
      throw err;
    }
  },

  /**
   * Generate a signed upload URL for direct browser uploads.
   * Useful for large files to bypass the server.
   */
  generateSignedUrl: (options = {}) => {
    const timestamp = Math.round(Date.now() / 1000);
    const params = {
      timestamp,
      folder: options.folder || 'toolhive/uploads',
      ...options,
    };
    const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
    return {
      signature,
      timestamp,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:    process.env.CLOUDINARY_API_KEY,
    };
  },
};

module.exports = storageService;
