'use strict';

const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { randomUUID } = require('crypto');
const { spawn }  = require('child_process');
const ytDlp      = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
const logger     = require('../utils/logger');

// ─── Duration / Views helpers ─────────────────────────────────────────────────

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

// ─── yt-dlp error messages ────────────────────────────────────────────────────

function ytDlpErrorMessage(err) {
  const raw = (err && (err.message || err)) || '';
  if (raw.includes('Sign in to confirm'))    return 'YouTube requires sign-in for this video. Try a different video.';
  if (raw.includes('age') && raw.includes('18')) return 'This video is age-restricted and cannot be downloaded.';
  if (raw.includes('Video unavailable'))     return 'This video is unavailable or has been removed.';
  if (raw.includes('requires payment'))      return 'This video requires purchase and cannot be downloaded.';
  if (raw.includes('Private video'))         return 'This is a private video and cannot be downloaded.';
  if (raw.includes('login required') || raw.includes('rate-limit') || raw.includes('Requested content is not available'))
    return 'This platform requires login to download. Try YouTube, TikTok, or Twitter instead.';
  if (raw.includes('429'))  return 'Too many requests to the platform. Please wait a minute and try again.';
  if (raw.includes('403'))  return 'Access denied by the platform. The video may be region-locked.';
  if (raw.includes('not supported') || raw.includes('No video formats found'))
    return 'This URL or platform is not supported.';
  if (raw.includes('timed out') || raw.includes('timeout'))
    return 'Request timed out. Please try again.';
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => l.startsWith('ERROR:'));
  if (errorLine) return errorLine.replace(/^ERROR:\s*\[[^\]]+\]\s*[^:]+:\s*/, '');
  return 'Could not download this video. The URL may be invalid or the platform may be temporarily unavailable.';
}

// ─── yt-dlp binary path ───────────────────────────────────────────────────────

function getYtDlpBin() {
  try {
    const pkgDir = path.dirname(require.resolve('yt-dlp-exec/package.json'));
    for (const name of ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos', 'yt-dlp.exe']) {
      const p = path.join(pkgDir, 'bin', name);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return 'yt-dlp';
}

// ─── Cookies (optional, for Instagram / Facebook) ────────────────────────────
// Set INSTAGRAM_COOKIES / FACEBOOK_COOKIES env vars on Render as base64-encoded
// Netscape cookies.txt files (exported from a logged-in browser).

const _cookieFiles = {};

(function loadCookies() {
  for (const [envKey, label] of [['INSTAGRAM_COOKIES', 'instagram'], ['FACEBOOK_COOKIES', 'facebook']]) {
    const b64 = process.env[envKey];
    if (!b64) continue;
    try {
      const p = path.join(os.tmpdir(), `th_cookies_${label}.txt`);
      fs.writeFileSync(p, Buffer.from(b64, 'base64').toString('utf8'), { mode: 0o600 });
      _cookieFiles[label] = p;
      logger.info(`Loaded ${label} cookies`);
    } catch (e) {
      logger.warn(`Failed to write ${label} cookies`, { error: e.message });
    }
  }
}());

function getCookiesFile(url) {
  if (/instagram\.com/.test(url))          return _cookieFiles.instagram || null;
  if (/facebook\.com|fb\.watch/.test(url)) return _cookieFiles.facebook  || null;
  return null;
}

// ─── Cobalt helper (parallel instances) ──────────────────────────────────────
//
// Set COBALT_API_KEY env var on Render to use the official api.cobalt.tools
// instance (most reliable). Without a key, we try many community instances.

const COBALT_API_KEY = process.env.COBALT_API_KEY || null;

// If API key provided → official instance only; else try all community instances in parallel
const COBALT_INSTANCES = COBALT_API_KEY
  ? ['https://api.cobalt.tools/']
  : [
    'https://cobalt.catvibers.me/',
    'https://co.wuk.sh/',
    'https://cobalt.uli.rocks/',
    'https://cobalt.api.trom.tf/',
    'https://cobalt-api.hyper.lol/',
    'https://cbl.raja.news/',
    'https://cobalt.drgns.space/',
    'https://api.cobalt.tools/',   // no-auth last resort (may 401)
  ];

async function tryCobaltInstance(apiUrl, bodyStr) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin':       'https://cobalt.tools',
      'Referer':      'https://cobalt.tools/',
    };
    if (COBALT_API_KEY && apiUrl.includes('api.cobalt.tools'))
      headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body:   bodyStr,
      signal: AbortSignal.timeout(10_000),
    });

    const text = await resp.text();
    if (!resp.ok) {
      logger.warn('Cobalt non-OK', { instance: apiUrl, status: resp.status, body: text.slice(0, 200) });
      return null;
    }

    logger.info('Cobalt success', { instance: apiUrl, snippet: text.slice(0, 200) });
    const data = JSON.parse(text);

    if ((data.status === 'tunnel' || data.status === 'redirect') && data.url)
      return { url: data.url, filename: data.filename || null };

    if (data.status === 'picker' && Array.isArray(data.picker) && data.picker[0]?.url)
      return { url: data.picker[0].url, filename: data.filename || null };

  } catch (e) {
    logger.warn('Cobalt instance error', { instance: apiUrl, error: e.message });
  }
  return null;
}

// ─── Instagram embed scraper (fallback when all Cobalt instances fail) ────────
// Fetches Instagram's public embed page, parses the CDN video URL from the HTML.
// Returns { url, filename } where url is a scontent CDN link the browser can
// download directly — no Cobalt required.

async function tryInstagramEmbed(videoUrl) {
  const match = videoUrl.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const shortcode = match[1];

  for (const embedPath of [`/p/${shortcode}/embed/captioned/`, `/p/${shortcode}/embed/`]) {
    try {
      const resp = await fetch(`https://www.instagram.com${embedPath}`, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer':         'https://www.instagram.com/',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) { logger.warn('Instagram embed non-OK', { status: resp.status }); continue; }

      const html = await resp.text();

      // Pattern 1: "video_url":"https://..."
      let m = html.match(/"video_url"\s*:\s*"([^"]+)"/);
      if (m) {
        const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        logger.info('Instagram embed: video_url found', { shortcode });
        return { url, filename: `instagram_${shortcode}.mp4` };
      }

      // Pattern 2: <video src="...">
      m = html.match(/<video[^>]+src="([^"]+)"/);
      if (m) {
        const url = m[1].replace(/&amp;/g, '&');
        logger.info('Instagram embed: video src found', { shortcode });
        return { url, filename: `instagram_${shortcode}.mp4` };
      }

      logger.warn('Instagram embed: no video URL in HTML', { shortcode, len: html.length });
    } catch (e) {
      logger.warn('Instagram embed error', { error: e.message, shortcode });
    }
  }
  return null;
}

async function tryCobalt(videoUrl, quality) {
  const isAudioQ = quality === 'mp3';
  const qMap = { '4k': '2160', '1080p': '1080', '720p': '720', '480p': '480', '360p': '360', 'webm': '1080' };

  // Strip tracking params from Instagram / TikTok URLs
  let cleanUrl = videoUrl;
  try {
    const u = new URL(videoUrl);
    if (/instagram\.com|tiktok\.com/.test(u.hostname)) {
      cleanUrl = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    }
  } catch { /* keep original */ }

  const bodyStr = JSON.stringify({
    url:          cleanUrl,
    downloadMode: isAudioQ ? 'audio' : 'auto',
    videoQuality: qMap[quality] || '720',
    filenameStyle: 'basic',
    ...(isAudioQ ? { audioFormat: 'mp3' } : {}),
  });

  // All instances start at the same time — first non-null result wins
  const cobaltResult = await new Promise((resolve) => {
    let pending = COBALT_INSTANCES.length;
    let settled = false;

    for (const instance of COBALT_INSTANCES) {
      tryCobaltInstance(instance, bodyStr)
        .then((result) => {
          if (result && !settled) { settled = true; resolve(result); }
          else if (!result && --pending === 0 && !settled) resolve(null);
        })
        .catch(() => { if (--pending === 0 && !settled) resolve(null); });
    }
  });

  if (cobaltResult) return cobaltResult;

  // Instagram-specific fallback: scrape the public embed page for the CDN URL
  if (/instagram\.com/.test(videoUrl) && !isAudioQ) {
    logger.info('All Cobalt failed for Instagram — trying embed scrape');
    const embedResult = await tryInstagramEmbed(videoUrl);
    if (embedResult) return embedResult;
  }

  return null;
}

// ─── Format selectors ─────────────────────────────────────────────────────────

// YouTube — separate streams merged by ffmpeg (-o - compatible)
const YT_FORMAT = {
  '4k':    'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720p':  'bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480p':  'bestvideo[height<=480]+bestaudio/best[height<=480]',
  '360p':  'best[height<=360]/worst',
  'mp3':   'bestaudio/best',
  'webm':  'bestvideo[height<=1080][ext=webm]+bestaudio[ext=webm]/best[ext=webm]',
};

// Other platforms — single pre-merged file (no ffmpeg stdout-merge needed)
const SIMPLE_FORMAT = {
  '4k':    'best[height<=2160]/best',
  '1080p': 'best[height<=1080]/best',
  '720p':  'best[height<=720]/best',
  '480p':  'best[height<=480]/best',
  '360p':  'best[height<=360]/worst',
  'mp3':   'bestaudio/best',
  'webm':  'best[ext=webm]/best',
};

// ─── Video info ───────────────────────────────────────────────────────────────

exports.getVideoInfo = async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http'))
    return res.status(400).json({ success: false, message: 'A valid video URL is required.' });

  logger.info('Video info request', { url });

  try {
    const opts = {
      dumpSingleJson:      true,
      noWarnings:          true,
      noCallHome:          true,
      noCheckCertificates: true,
      noPlaylist:          true,
      socketTimeout:       30,
      retries:             2,
      ffmpegLocation:      ffmpegPath,
    };
    if (/youtube\.com|youtu\.be/.test(url))
      opts.extractorArgs = 'youtube:player_client=android,web';

    const cookiesFile = getCookiesFile(url);
    if (cookiesFile) opts.cookies = cookiesFile;

    const info = await ytDlp(url, opts);
    return res.json({
      success: true,
      data: {
        title:    info.title     || 'Unknown Title',
        author:   info.uploader  || info.channel || info.creator || 'Unknown',
        thumbnail: info.thumbnail || null,
        duration: formatDuration(info.duration),
        views:    formatViews(info.view_count),
        platform: info.extractor_key || 'Unknown',
      },
    });
  } catch (err) {
    logger.error('Video info error', { url, error: err.message });
    return res.status(400).json({ success: false, message: ytDlpErrorMessage(err) });
  }
};

// ─── Download (GET) ───────────────────────────────────────────────────────────
//
// Two modes:
//   ?validate=1  — fast pre-check (Cobalt or yt-dlp --print url). Returns JSON.
//                  Frontend uses this to detect errors before navigating.
//   (no flag)    — stream the video via yt-dlp -o - piped to HTTP response.

exports.downloadVideoGet = async (req, res) => {
  const { url, quality = '720p', validate } = req.query;
  if (!url || typeof url !== 'string' || !url.startsWith('http'))
    return res.status(400).json({ success: false, message: 'A valid video URL is required.' });

  const isAudio    = quality === 'mp3';
  const ext        = isAudio ? 'mp3' : 'mp4';
  const isYouTube  = /youtube\.com|youtu\.be/.test(url);
  const format     = isYouTube ? (YT_FORMAT[quality] || YT_FORMAT['720p']) : (SIMPLE_FORMAT[quality] || 'best');
  const ytDlpBin   = getYtDlpBin();
  const cookiesFile = getCookiesFile(url);

  // Shared yt-dlp flags
  const baseArgs = [
    url, '-f', format,
    '--no-playlist', '--no-warnings', '--no-call-home', '--no-check-certificates',
    '--ffmpeg-location', ffmpegPath,
  ];
  if (isYouTube)  baseArgs.push('--extractor-args', 'youtube:player_client=android,web');
  if (cookiesFile) baseArgs.push('--cookies', cookiesFile);

  // ── Validate mode ──────────────────────────────────────────────────────────
  if (validate === '1') {
    logger.info('Video validate', { url, quality, isYouTube });

    // Non-YouTube: try Cobalt first (all instances in parallel, 10 s each)
    if (!isYouTube) {
      const cobalt = await tryCobalt(url, quality);
      if (cobalt) {
        logger.info('Validate: Cobalt success');
        return res.json({ success: true, directUrl: cobalt.url, filename: cobalt.filename });
      }
      logger.warn('Validate: all Cobalt instances failed, falling back to yt-dlp');
    }

    // yt-dlp --print url (quick format-availability check, no download)
    const checkProc = spawn(ytDlpBin, [
      ...baseArgs, '--print', 'url', '--socket-timeout', '20', '--retries', '1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let checkOut = '';
    let checkErr = '';
    checkProc.stdout.on('data', (d) => { checkOut += d.toString(); });
    checkProc.stderr.on('data', (d) => { checkErr = (checkErr + d.toString()).slice(-2000); });

    const checkTimer = setTimeout(() => {
      checkProc.kill('SIGTERM');
      if (!res.headersSent)
        res.status(504).json({ success: false, message: 'Validation timed out. Please try again.' });
    }, 28_000);

    checkProc.on('close', (code) => {
      clearTimeout(checkTimer);
      if (res.headersSent) return;
      if (code === 0 && checkOut.trim())
        res.json({ success: true });
      else
        res.status(400).json({ success: false, message: ytDlpErrorMessage({ message: checkErr }) });
    });
    return;
  }

  // ── Full streaming download ────────────────────────────────────────────────
  logger.info('Video stream', { url, quality, format, isYouTube, hasCookies: !!cookiesFile });

  const args = [...baseArgs, '-o', '-', '--socket-timeout', '60', '--retries', '2'];
  if (isAudio)        args.push('--extract-audio', '--audio-format', 'mp3');
  else                args.push('--merge-output-format', 'mp4');

  const proc = spawn(ytDlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let headersFlushed = false;
  let stderrBuf      = '';
  let startupTimer   = null;

  proc.stderr.on('data', (d) => { stderrBuf = (stderrBuf + d.toString()).slice(-3000); });

  startupTimer = setTimeout(() => {
    if (!headersFlushed && !res.writableEnded) {
      proc.kill('SIGTERM');
      res.status(504).json({ success: false, message: 'Download timed out. Please try again.' });
    }
  }, 45_000);

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

  req.on('close', () => { clearTimeout(startupTimer); if (!proc.killed) proc.kill('SIGTERM'); });

  proc.on('error', (err) => {
    clearTimeout(startupTimer);
    logger.error('yt-dlp spawn error', { error: err.message });
    if (!headersFlushed && !res.writableEnded)
      res.status(500).json({ success: false, message: 'Failed to start download.' });
    else if (!res.writableEnded) res.end();
  });

  proc.on('close', (code) => {
    clearTimeout(startupTimer);
    if (code !== 0 && code !== null) logger.warn('yt-dlp non-zero exit', { code, url, quality });
    if (!headersFlushed && !res.writableEnded) {
      res.status(400).json({ success: false, message: ytDlpErrorMessage({ message: stderrBuf }) });
    } else if (!res.writableEnded) res.end();
  });
};

// ─── POST download (legacy, kept for compatibility) ───────────────────────────

const QUALITY_FORMAT = {
  '4k':    'bestvideo[height<=2160]+bestaudio/best[height<=2160]/best',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
  '720p':  'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
  '480p':  'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
  '360p':  'best[height<=360][ext=mp4]/best[height<=360]/worst',
  'mp3':   'bestaudio/best',
  'webm':  'bestvideo[height<=1080][ext=webm]+bestaudio[ext=webm]/best[ext=webm]/bestvideo[height<=1080]+bestaudio/best',
};

exports.downloadVideo = async (req, res) => {
  const { url, quality = '720p' } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http'))
    return res.status(400).json({ success: false, message: 'A valid video URL is required.' });

  const isAudio = quality === 'mp3';
  const isWebm  = quality === 'webm';
  const ext     = isAudio ? 'mp3' : isWebm ? 'webm' : 'mp4';
  const format  = QUALITY_FORMAT[quality] || QUALITY_FORMAT['720p'];
  const tmpFile = path.join(os.tmpdir(), `toolhive_${randomUUID()}.${ext}`);

  try {
    const ytDlpOptions = {
      output: tmpFile, format,
      noWarnings: true, noCallHome: true, noCheckCertificates: true,
      noPlaylist: true, socketTimeout: 60, retries: 2,
      extractorArgs: 'youtube:player_client=android,web',
      ffmpegLocation: ffmpegPath,
    };
    if (isAudio) { ytDlpOptions.extractAudio = true; ytDlpOptions.audioFormat = 'mp3'; ytDlpOptions.audioQuality = 0; }
    else         { ytDlpOptions.mergeOutputFormat = 'mp4'; }

    await ytDlp(url, ytDlpOptions);

    let actualFile = tmpFile;
    if (!fs.existsSync(tmpFile)) {
      for (const c of [tmpFile + '.mp4', tmpFile + '.webm', tmpFile + '.mkv', tmpFile + '.mp3'])
        if (fs.existsSync(c)) { actualFile = c; break; }
    }
    if (!fs.existsSync(actualFile)) throw new Error('Download failed — output file not created.');

    const stat = fs.statSync(actualFile);
    res.setHeader('Content-Disposition', `attachment; filename="toolhive_video.${ext}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : isWebm ? 'video/webm' : 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const rs = fs.createReadStream(actualFile);
    rs.pipe(res);
    rs.on('close', () => fs.unlink(actualFile, () => {}));
    rs.on('error', (err) => { fs.unlink(actualFile, () => {}); if (!res.headersSent) res.status(500).json({ success: false, message: err.message }); });
  } catch (err) {
    fs.unlink(tmpFile, () => {});
    if (!res.headersSent)
      res.status(400).json({ success: false, message: ytDlpErrorMessage(err) });
  }
};

// ─── FFmpeg helpers ───────────────────────────────────────────────────────────

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { code === 0 ? resolve(stderr) : reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-600)}`)); });
    proc.on('error', reject);
  });
}

function videoMimeType(ext) {
  return ({ mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska', gif: 'image/gif', mp3: 'audio/mpeg' })[ext] || 'video/mp4';
}

// ─── Video process ────────────────────────────────────────────────────────────

exports.processVideo = async (req, res) => {
  const { toolSlug, options: optionsStr } = req.body;
  const options = JSON.parse(optionsStr || '{}');
  const fileList = req.files?.length ? req.files : req.file ? [req.file] : [];
  if (!fileList.length) return res.status(400).json({ success: false, message: 'No video file uploaded.' });

  const id = randomUUID();
  const tmpDir = os.tmpdir();
  const inputPaths = fileList.map((f) => f.path);
  let outputPath = null, outputName = 'output.mp4', outputExt = 'mp4';

  logger.info('Video process', { toolSlug, options });

  try {
    switch (toolSlug) {
      case 'compress': {
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`); outputName = 'compressed_video.mp4';
        const crf = options.quality === 'high' ? '20' : options.quality === 'low' ? '32' : '26';
        await runFFmpeg(['-i', inputPaths[0], '-vcodec', 'libx264', '-crf', crf, '-preset', 'fast', '-movflags', '+faststart', '-y', outputPath]);
        break;
      }
      case 'trim': {
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`); outputName = 'trimmed_video.mp4';
        await runFFmpeg(['-i', inputPaths[0], '-ss', options.startTime || '00:00:00', '-to', options.endTime || '00:01:00', '-c', 'copy', '-y', outputPath]);
        break;
      }
      case 'convert': {
        const fmt = (options.format || 'mp4').toLowerCase();
        outputExt = fmt; outputPath = path.join(tmpDir, `th_out_${id}.${fmt}`); outputName = `converted.${fmt}`;
        const args = ['-i', inputPaths[0]];
        if (fmt === 'mp4')  args.push('-vcodec', 'libx264', '-acodec', 'aac');
        if (fmt === 'webm') args.push('-vcodec', 'libvpx-vp9', '-acodec', 'libopus');
        if (fmt === 'avi')  args.push('-vcodec', 'mpeg4', '-acodec', 'mp3');
        args.push('-y', outputPath);
        await runFFmpeg(args);
        break;
      }
      case 'to-mp3': {
        outputExt = 'mp3'; outputPath = path.join(tmpDir, `th_out_${id}.mp3`); outputName = 'extracted_audio.mp3';
        await runFFmpeg(['-i', inputPaths[0], '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', outputPath]);
        break;
      }
      case 'video-to-gif': {
        outputExt = 'gif'; outputPath = path.join(tmpDir, `th_out_${id}.gif`); outputName = 'output.gif';
        await runFFmpeg(['-i', inputPaths[0], '-vf', `fps=${options.fps || '10'},scale=${options.scale || '480'}:-1:flags=lanczos`, '-loop', '0', '-y', outputPath]);
        break;
      }
      case 'speed': {
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`); outputName = 'speed_changed.mp4';
        const speed = parseFloat(options.speed || '1.5');
        const pts   = (1 / speed).toFixed(6);
        try {
          await runFFmpeg(['-i', inputPaths[0], '-filter_complex', `[0:v]setpts=${pts}*PTS[v];[0:a]atempo=${speed}[a]`, '-map', '[v]', '-map', '[a]', '-y', outputPath]);
        } catch {
          await runFFmpeg(['-i', inputPaths[0], '-vf', `setpts=${pts}*PTS`, '-an', '-y', outputPath]);
        }
        break;
      }
      case 'mute': {
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`); outputName = 'muted_video.mp4';
        await runFFmpeg(['-i', inputPaths[0], '-an', '-c:v', 'copy', '-y', outputPath]);
        break;
      }
      case 'merge': {
        outputPath = path.join(tmpDir, `th_out_${id}.mp4`); outputName = 'merged_video.mp4';
        const concatFile = path.join(tmpDir, `th_concat_${id}.txt`);
        fs.writeFileSync(concatFile, inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
        try {
          try { await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-y', outputPath]); }
          catch { await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-y', outputPath]); }
        } finally { fs.unlink(concatFile, () => {}); }
        break;
      }
      default:
        return res.status(400).json({ success: false, message: `Unknown video tool: ${toolSlug}` });
    }

    if (!fs.existsSync(outputPath))
      return res.status(500).json({ success: false, message: 'Processing failed — output file not created.' });

    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('Content-Type', videoMimeType(outputExt));
    res.setHeader('Content-Length', stat.size);

    const rs = fs.createReadStream(outputPath);
    rs.pipe(res);
    rs.on('close', () => fs.unlink(outputPath, () => {}));
    rs.on('error', (err) => { fs.unlink(outputPath, () => {}); if (!res.headersSent) res.status(500).json({ success: false, message: err.message }); });

  } catch (err) {
    if (outputPath) fs.unlink(outputPath, () => {});
    logger.error('Video process error', { toolSlug, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    inputPaths.forEach((p) => fs.unlink(p, () => {}));
  }
};
