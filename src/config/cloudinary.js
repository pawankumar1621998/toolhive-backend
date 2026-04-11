/**
 * Cloudinary configuration module.
 *
 * Configures and exports the cloudinary v2 SDK singleton using credentials
 * from environment variables.  Import this module in any file that needs to
 * upload, transform, or delete assets via Cloudinary.
 */

const cloudinary = require('cloudinary').v2;
const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = require('./index');

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true, // always use HTTPS URLs
});

module.exports = { cloudinary };
