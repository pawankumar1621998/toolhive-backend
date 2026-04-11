'use strict';

/**
 * Video Controller
 *
 * POST /video/info     — fetch title, thumbnail, duration, views from any URL
 * POST /video/download — download the video and stream it back to the client
 *
 * Uses yt-dlp-exec (auto-downloads yt-dlp binary) + ffmpeg-static (no system ffmpeg needed).
 */

const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { randomUUID } = require('crypto');
const ytDlp    = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
const logger   = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(count) {
  if (!count) return null;
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B views`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M views`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K views`;
  return `${count} views`;
}

/**
 * yt-dlp format selector — prefers pre-merged single-file formats to avoid
 * requiring ffmpeg. Falls back to merged when a pre-merged file is not available.
 */
const QUALITY_FORMAT = {
  '4k':    'bestvideo[height<=2160]+bestaudio/best[height<=2160]/best',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
  '720p':  'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
  '480p':  'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
  '360p':  'best[height<=360][ext=mp4]/best[height<=360]/worst',
  'mp3':   'bestaudio/best',
  'webm':  'bestvideo[height<=1080][ext=webm]+bestaudio[ext=webm]/best[ext=webm]/bestvideo[height<=1080]+bestaudio/best',
};

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET video metadata — title, thumbnail, duration, author, views.
 * No file download; fast lookup via yt-dlp --dump-single-json.
 */
exports.getVideoInfo = async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'A valid video URL is required.' });
  }

  logger.info('Video info request', { url });

  const info = await ytDlp(url, {
    dumpSingleJson:    true,
    noWarnings:        true,
    noCallHome:        true,
    noCheckCertificates: true,
    ffmpegLocation:    ffmpegPath,
  });

  return res.json({
    success: true,
    data: {
      title:     info.title     || 'Unknown Title',
      author:    info.uploader  || info.channel || info.creator || 'Unknown',
      thumbnail: info.thumbnail || null,
      duration:  formatDuration(info.duration),
      views:     formatViews(info.view_count),
      platform:  info.extractor_key || 'Unknown',
    },
  });
};

/**
 * Download a video and stream it back.
 * yt-dlp writes to a temp file (required for format merging via ffmpeg),
 * then we stream the file to the client and clean up.
 */
exports.downloadVideo = async (req, res) => {
  const { url, quality = '720p' } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'A valid video URL is required.' });
  }

  const isAudio  = quality === 'mp3';
  const isWebm   = quality === 'webm';
  const ext      = isAudio ? 'mp3' : isWebm ? 'webm' : 'mp4';
  const format   = QUALITY_FORMAT[quality] || QUALITY_FORMAT['720p'];
  const tmpFile  = path.join(os.tmpdir(), `toolhive_${randomUUID()}.${ext}`);

  logger.info('Video download start', { url, quality, ext });

  try {
    const ytDlpOptions = {
      output:             tmpFile,
      format,
      noWarnings:         true,
      noCallHome:         true,
      noCheckCertificates: true,
      noPlaylist:         true,
      ffmpegLocation:     ffmpegPath,
    };

    // For MP3, extract and convert audio
    if (isAudio) {
      ytDlpOptions.extractAudio    = true;
      ytDlpOptions.audioFormat     = 'mp3';
      ytDlpOptions.audioQuality    = 0; // best
    } else {
      ytDlpOptions.mergeOutputFormat = 'mp4';
    }

    await ytDlp(url, ytDlpOptions);

    // yt-dlp might add the extension itself — find the actual output file
    let actualFile = tmpFile;
    if (!fs.existsSync(tmpFile)) {
      // Check common extensions yt-dlp might use
      for (const candidate of [tmpFile + '.mp4', tmpFile + '.webm', tmpFile + '.mkv', tmpFile + '.mp3']) {
        if (fs.existsSync(candidate)) { actualFile = candidate; break; }
      }
    }

    if (!fs.existsSync(actualFile)) {
      throw new Error('Download failed — output file not created.');
    }

    const stat = fs.statSync(actualFile);
    const mimeType = isAudio ? 'audio/mpeg' : isWebm ? 'video/webm' : 'video/mp4';

    res.setHeader('Content-Disposition', `attachment; filename="toolhive_video.${ext}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-File-Size', stat.size);

    logger.info('Streaming video file', { size: stat.size, ext });

    const readStream = fs.createReadStream(actualFile);
    readStream.pipe(res);
    readStream.on('close', () => {
      fs.unlink(actualFile, () => {}); // clean up temp file
    });
    readStream.on('error', (err) => {
      logger.error('Stream error', { error: err.message });
      fs.unlink(actualFile, () => {});
      if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    });

  } catch (err) {
    fs.unlink(tmpFile, () => {});
    logger.error('Video download error', { url, error: err.message });
    throw err;
  }
};
