'use strict';

/**
 * Video Controller
 *
 * POST /video/info     — fetch title, thumbnail, duration, views from any URL
 * POST /video/download — download the video and stream it back to the client
 * POST /video/process  — FFmpeg-based processing: compress, trim, merge, convert,
 *                        to-mp3, video-to-gif, speed, mute
 *
 * Uses yt-dlp-exec (auto-downloads yt-dlp binary) + ffmpeg-static (no system ffmpeg needed).
 */

const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
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
 * Extract a clean, user-facing error message from a yt-dlp exception.
 * yt-dlp-exec rejects with an error whose message contains the stderr output.
 */
function ytDlpErrorMessage(err) {
  const raw = err.message || '';
  if (raw.includes('Sign in to confirm'))         return 'YouTube requires sign-in for this video. Try a different video or format.';
  if (raw.includes('age') && raw.includes('18'))  return 'This video is age-restricted and cannot be downloaded.';
  if (raw.includes('Video unavailable'))           return 'This video is unavailable or has been removed.';
  if (raw.includes('requires payment'))            return 'This video requires purchase and cannot be downloaded.';
  if (raw.includes('Private video'))               return 'This is a private video and cannot be downloaded.';
  if (raw.includes('login required') || raw.includes('rate-limit') || raw.includes('Requested content is not available'))
    return 'Instagram/Facebook has blocked this download — these platforms require a logged-in session from a real browser. Please try a YouTube, TikTok, Twitter, or Vimeo URL instead.';
  if (raw.includes('429'))                         return 'Too many requests to the platform. Please wait a minute and try again.';
  if (raw.includes('403'))                         return 'Access denied by the platform. The video may be region-locked or require login.';
  if (raw.includes('not supported') || raw.includes('No video formats found'))
    return 'This URL or platform is not supported.';
  if (raw.includes('timed out') || raw.includes('timeout'))
    return 'Request timed out. Please try again.';
  // Return last meaningful line from stderr
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => l.startsWith('ERROR:'));
  if (errorLine) return errorLine.replace(/^ERROR:\s*\[[^\]]+\]\s*[^:]+:\s*/, '');
  return 'Could not download this video. The URL may be invalid, the platform may require login, or the video may be restricted.';
}

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

  try {
    const ytDlpOpts = {
      dumpSingleJson:      true,
      noWarnings:          true,
      noCallHome:          true,
      noCheckCertificates: true,
      noPlaylist:          true,
      socketTimeout:       30,
      retries:             2,
      ffmpegLocation:      ffmpegPath,
    };
    // YouTube-only bot-detection bypass — applying it globally breaks other extractors
    if (/youtube\.com|youtu\.be/.test(url)) {
      ytDlpOpts.extractorArgs = 'youtube:player_client=android,web';
    }
    const info = await ytDlp(url, ytDlpOpts);

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
  } catch (err) {
    logger.error('Video info error', { url, error: err.message });
    const message = ytDlpErrorMessage(err);
    return res.status(400).json({ success: false, message });
  }
};

/**
 * GET /video/download?url=...&quality=...
 *
 * Sends Content-Disposition: attachment headers IMMEDIATELY via res.flushHeaders(),
 * then pipes yt-dlp stdout directly to the response — data streams in real-time.
 *
 * Browser receives the attachment header in <1s → shows download dialog and
 * closes the blank tab instantly (Chrome behaviour). No more 60-second wait.
 */
// YouTube: separate video+audio streams merged by ffmpeg
const STREAM_FORMAT = {
  '4k':    'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720p':  'bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480p':  'bestvideo[height<=480]+bestaudio/best[height<=480]',
  '360p':  'best[height<=360]/worst',
  'mp3':   'bestaudio/best',
  'webm':  'bestvideo[height<=1080][ext=webm]+bestaudio[ext=webm]/best[ext=webm]',
};

// Non-YouTube (Instagram, TikTok, Facebook, etc.): pre-merged single-file formats
// bestvideo+bestaudio requires separate streams which most platforms don't serve
const SIMPLE_FORMAT = {
  '4k':    'best[height<=2160]/best',
  '1080p': 'best[height<=1080]/best',
  '720p':  'best[height<=720]/best',
  '480p':  'best[height<=480]/best',
  '360p':  'best[height<=360]/worst',
  'mp3':   'bestaudio/best',
  'webm':  'best[ext=webm]/best',
};

function getYtDlpBin() {
  try {
    const pkgDir = path.dirname(require.resolve('yt-dlp-exec/package.json'));
    for (const name of ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos', 'yt-dlp.exe']) {
      const p = path.join(pkgDir, 'bin', name);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return 'yt-dlp'; // fallback: system PATH
}

exports.downloadVideoGet = (req, res) => {
  const { url, quality = '720p' } = req.query;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'A valid video URL is required.' });
  }

  const isAudio   = quality === 'mp3';
  const ext       = isAudio ? 'mp3' : 'mp4';
  const isYouTube = /youtube\.com|youtu\.be/.test(url);

  // YouTube supports separate video+audio merge via stdout (-o -) + ffmpeg.
  // Other platforms (Instagram, TikTok, Facebook, Twitter, Vimeo…) serve
  // pre-merged single-file formats — using bestvideo+bestaudio on them fails
  // because yt-dlp cannot merge two separate streams while writing to stdout.
  const format = isYouTube
    ? (STREAM_FORMAT[quality]  || STREAM_FORMAT['720p'])
    : (SIMPLE_FORMAT[quality] || 'best');

  logger.info('Video stream GET', { url, quality, format, isYouTube });

  const ytDlpBin = getYtDlpBin();

  const args = [
    url, '-f', format, '-o', '-',
    '--no-playlist',
    '--socket-timeout', '60',
    '--retries', '2',
    '--no-warnings',
    '--no-call-home',
    '--no-check-certificates',
    '--ffmpeg-location', ffmpegPath,
  ];

  // YouTube-specific bot-detection bypass — breaks other extractors if applied globally
  if (isYouTube) args.push('--extractor-args', 'youtube:player_client=android,web');

  // Instagram / Facebook: send a mobile browser user-agent to reduce rate-limiting.
  // Note: server IPs are often blocked regardless — cookies would be the real fix,
  // but we surface a clear error message when it fails.
  if (/instagram\.com|facebook\.com|fb\.watch/.test(url)) {
    args.push(
      '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
    );
  }

  if (isAudio) {
    args.push('--extract-audio', '--audio-format', 'mp3');
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  const proc = spawn(ytDlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let headersFlushed = false;
  let stderrBuf     = '';
  let startupTimer  = null;

  proc.stderr.on('data', (d) => {
    stderrBuf = (stderrBuf + d.toString()).slice(-3000);
  });

  // If yt-dlp produces no output within 45 s, give up and return a JSON error.
  startupTimer = setTimeout(() => {
    if (!headersFlushed && !res.writableEnded) {
      proc.kill('SIGTERM');
      res.status(504).json({ success: false, message: 'Download timed out. Please try again.' });
    }
  }, 45_000);

  // Delay flushing headers until yt-dlp actually starts sending data.
  // This way, if yt-dlp fails immediately we can still return a JSON error
  // instead of an empty/corrupt file that the browser silently "downloads".
  proc.stdout.on('data', (chunk) => {
    if (!headersFlushed) {
      headersFlushed = true;
      clearTimeout(startupTimer);
      res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
      res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
    }
    res.write(chunk);
  });

  req.on('close', () => {
    clearTimeout(startupTimer);
    if (!proc.killed) proc.kill('SIGTERM');
  });

  proc.on('error', (err) => {
    clearTimeout(startupTimer);
    logger.error('yt-dlp spawn error', { error: err.message });
    if (!headersFlushed && !res.writableEnded) {
      res.status(500).json({ success: false, message: 'Failed to start download.' });
    } else if (!res.writableEnded) res.end();
  });

  proc.on('close', (code) => {
    clearTimeout(startupTimer);
    if (code !== 0 && code !== null) logger.warn('yt-dlp exited non-zero', { code, url, quality });
    if (!headersFlushed && !res.writableEnded) {
      // yt-dlp quit before sending any data — send a proper error message
      const msg = ytDlpErrorMessage({ message: stderrBuf });
      return res.status(400).json({ success: false, message: msg });
    }
    if (!res.writableEnded) res.end();
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
      output:              tmpFile,
      format,
      noWarnings:          true,
      noCallHome:          true,
      noCheckCertificates: true,
      noPlaylist:          true,
      socketTimeout:       60,
      retries:             2,
      extractorArgs:       'youtube:player_client=android,web',
      ffmpegLocation:      ffmpegPath,
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
    if (!res.headersSent) {
      return res.status(400).json({ success: false, message: ytDlpErrorMessage(err) });
    }
  }
};

// ─── FFmpeg process helper ─────────────────────────────────────────────────────

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
    proc.on('error', reject);
  });
}

function videoMimeType(ext) {
  const map = { mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska', gif: 'image/gif', mp3: 'audio/mpeg' };
  return map[ext] || 'video/mp4';
}

// ─── Video process controller ─────────────────────────────────────────────────

/**
 * POST /video/process
 * Body (multipart/form-data): toolSlug, options (JSON), file (single) or files[] (merge)
 */
exports.processVideo = async (req, res) => {
  const { toolSlug, options: optionsStr } = req.body;
  const options = JSON.parse(optionsStr || '{}');

  const fileList = req.files && req.files.length ? req.files : req.file ? [req.file] : [];
  if (!fileList.length) {
    return res.status(400).json({ success: false, message: 'No video file uploaded.' });
  }

  const id = randomUUID();
  const tmpDir = os.tmpdir();

  // Input paths (multer disk storage writes directly, use req.file.path)
  const inputPaths = fileList.map((f) => f.path);
  let outputPath = null;
  let outputName = 'output.mp4';
  let outputExt  = 'mp4';

  logger.info('Video process request', { toolSlug, options });

  try {
    switch (toolSlug) {

      case 'compress': {
        outputExt  = 'mp4';
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`);
        outputName = 'compressed_video.mp4';
        const crf  = options.quality === 'high' ? '20' : options.quality === 'low' ? '32' : '26';
        await runFFmpeg(['-i', inputPaths[0], '-vcodec', 'libx264', '-crf', crf, '-preset', 'fast', '-movflags', '+faststart', '-y', outputPath]);
        break;
      }

      case 'trim': {
        outputExt  = 'mp4';
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`);
        outputName = 'trimmed_video.mp4';
        const start = options.startTime || '00:00:00';
        const end   = options.endTime   || '00:01:00';
        await runFFmpeg(['-i', inputPaths[0], '-ss', start, '-to', end, '-c', 'copy', '-y', outputPath]);
        break;
      }

      case 'convert': {
        const fmt  = (options.format || 'mp4').toLowerCase();
        outputExt  = fmt;
        outputPath = path.join(tmpDir, `th_out_${id}.${fmt}`);
        outputName = `converted.${fmt}`;
        const args = ['-i', inputPaths[0]];
        if (fmt === 'mp4')  args.push('-vcodec', 'libx264', '-acodec', 'aac');
        if (fmt === 'webm') args.push('-vcodec', 'libvpx-vp9', '-acodec', 'libopus');
        if (fmt === 'avi')  args.push('-vcodec', 'mpeg4', '-acodec', 'mp3');
        args.push('-y', outputPath);
        await runFFmpeg(args);
        break;
      }

      case 'to-mp3': {
        outputExt  = 'mp3';
        outputPath = path.join(tmpDir, `th_out_${id}.mp3`);
        outputName = 'extracted_audio.mp3';
        await runFFmpeg(['-i', inputPaths[0], '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', outputPath]);
        break;
      }

      case 'video-to-gif': {
        outputExt  = 'gif';
        outputPath = path.join(tmpDir, `th_out_${id}.gif`);
        outputName = 'output.gif';
        const fps   = options.fps   || '10';
        const scale = options.scale || '480';
        await runFFmpeg(['-i', inputPaths[0], '-vf', `fps=${fps},scale=${scale}:-1:flags=lanczos`, '-loop', '0', '-y', outputPath]);
        break;
      }

      case 'speed': {
        outputExt  = 'mp4';
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`);
        outputName = 'speed_changed.mp4';
        const speed = parseFloat(options.speed || '1.5');
        const pts   = (1 / speed).toFixed(6);
        // Try with audio; fallback to video-only if no audio stream
        try {
          await runFFmpeg([
            '-i', inputPaths[0],
            '-filter_complex', `[0:v]setpts=${pts}*PTS[v];[0:a]atempo=${speed}[a]`,
            '-map', '[v]', '-map', '[a]',
            '-y', outputPath,
          ]);
        } catch {
          // No audio stream — video-only
          await runFFmpeg([
            '-i', inputPaths[0],
            '-vf', `setpts=${pts}*PTS`,
            '-an', '-y', outputPath,
          ]);
        }
        break;
      }

      case 'mute': {
        outputExt  = 'mp4';
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`);
        outputName = 'muted_video.mp4';
        await runFFmpeg(['-i', inputPaths[0], '-an', '-c:v', 'copy', '-y', outputPath]);
        break;
      }

      case 'merge': {
        outputExt  = 'mp4';
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`);
        outputName = 'merged_video.mp4';
        const concatFile = path.join(tmpDir, `th_concat_${id}.txt`);
        const lines = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(concatFile, lines);
        try {
          // Try fast stream copy first; if codecs differ, re-encode for compatibility
          try {
            await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-y', outputPath]);
          } catch {
            await runFFmpeg([
              '-f', 'concat', '-safe', '0', '-i', concatFile,
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'aac', '-b:a', '128k',
              '-y', outputPath,
            ]);
          }
        } finally {
          fs.unlink(concatFile, () => {});
        }
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown video tool: ${toolSlug}` });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ success: false, message: 'Processing failed — output file not created.' });
    }

    const stat     = fs.statSync(outputPath);
    const mimeType = videoMimeType(outputExt);

    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Output-Name', outputName);

    logger.info('Streaming processed video', { toolSlug, size: stat.size, ext: outputExt });

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', () => { fs.unlink(outputPath, () => {}); });
    readStream.on('error', (err) => {
      logger.error('Process stream error', { error: err.message });
      fs.unlink(outputPath, () => {});
      if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    });

  } catch (err) {
    if (outputPath) fs.unlink(outputPath, () => {});
    logger.error('Video process error', { toolSlug, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    // Clean up input temp files
    inputPaths.forEach((p) => fs.unlink(p, () => {}));
  }
};
