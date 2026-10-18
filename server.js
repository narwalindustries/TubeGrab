const express = require('express');
const { spawn, execSync } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
process.on('uncaughtException', err => {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.syscall === 'write')) return;
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
});

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (process.env[key] === undefined) process.env[key] = val;
        }
      }
      console.log('[Config] Loaded environment variables from .env');
    } catch (_) {}
  }
}
loadEnvFile();

const API_SECRET_KEY = process.env.API_SECRET_KEY || '';
const PORT = process.env.PORT || 3000;

// ---------- Platform-Independent Binary Auto-Downloader & Auto-Updater ----------
const BIN_DIR = path.join(__dirname, 'bin');
try { fs.mkdirSync(BIN_DIR, { recursive: true }); } catch (_) {}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
    try {
      execSync(`${curlCmd} -L -f -s -S --retry 3 "${url}" -o "${destPath}"`, { stdio: 'ignore' });
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(destPath, 0o755); } catch (_) {}
        }
        return resolve(destPath);
      }
    } catch (_) {}

    // Fallback: Node.js native https/http with redirect follower
    const makeRequest = (currentUrl, redirects = 0) => {
      if (redirects > 8) return reject(new Error('Too many redirects'));
      try {
        const parsed = new URL(currentUrl);
        const client = parsed.protocol === 'http:' ? http : https;
        const req = client.get(parsed, { headers: { 'User-Agent': 'TubeGrab/1.0 (Downloader)' } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).href;
            return makeRequest(nextUrl, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Failed to download: status ${res.statusCode}`));
          }
          const fileStream = fs.createWriteStream(destPath);
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close(() => {
              if (process.platform !== 'win32') {
                try { fs.chmodSync(destPath, 0o755); } catch (_) {}
              }
              resolve(destPath);
            });
          });
          fileStream.on('error', err => {
            try { fs.unlinkSync(destPath); } catch (_) {}
            reject(err);
          });
        });
        req.on('error', reject);
      } catch (err) {
        reject(err);
      }
    };
    makeRequest(url);
  });
}

function extractZip(zipPath, targetDir) {
  if (process.platform === 'win32') {
    try {
      execSync(`tar.exe -xf "${zipPath}" -C "${targetDir}"`, { stdio: 'ignore' });
    } catch (_) {
      try {
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`, { stdio: 'ignore' });
      } catch (_) {}
    }
  } else {
    try {
      execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'ignore' });
    } catch (_) {
      try {
        execSync(`tar -xf "${zipPath}" -C "${targetDir}"`, { stdio: 'ignore' });
      } catch (_) {}
    }
  }
}

function resolveBinary(name) {
  const isWin = process.platform === 'win32';
  const binaryName = isWin ? `${name}.exe` : name;
  const localBin = path.join(BIN_DIR, binaryName);
  if (fs.existsSync(localBin)) {
    if (!isWin) try { fs.chmodSync(localBin, 0o755); } catch (_) {}
    return localBin;
  }

  const envKey = name.toLowerCase() === 'yt-dlp' ? 'YTDLP_PATH' : `${name.toUpperCase()}_PATH`;
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];

  try {
    const cmd = isWin ? `where.exe ${binaryName}` : `which ${binaryName}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}

  if (isWin) {
    const wingetLink = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', binaryName);
    if (fs.existsSync(wingetLink)) return wingetLink;
  }

  return localBin;
}

let YTDLP = resolveBinary('yt-dlp');
let FFMPEG = resolveBinary('ffmpeg');

let isUpdatingYtdlp = false;
let lastUpdateCheck = 0;

function autoUpdateYtdlp(force = false) {
  if (isUpdatingYtdlp) return;
  if (!force && Date.now() - lastUpdateCheck < 60 * 60 * 1000) return;
  const binary = resolveBinary('yt-dlp') || YTDLP;
  if (!binary || !fs.existsSync(binary)) return;

  isUpdatingYtdlp = true;
  lastUpdateCheck = Date.now();

  try {
    const p = spawn(binary, ['--update-to', 'nightly'], { windowsHide: true });
    let out = '';
    p.stdout?.on('data', d => { out += d; });
    p.stderr?.on('data', d => { out += d; });
    p.on('close', () => {
      isUpdatingYtdlp = false;
      const line = out.trim().split(/\r?\n/)[0] || '';
      if (line) {
        if (/403|rate\s*limit/i.test(line)) {
          console.log('[Auto-Updater] yt-dlp is current (GitHub rate limit cooldown, running active build)');
        } else {
          console.log(`[Auto-Updater] yt-dlp: ${line}`);
        }
      }
      YTDLP = resolveBinary('yt-dlp');
    });
    p.on('error', () => { isUpdatingYtdlp = false; });
  } catch (_) {
    isUpdatingYtdlp = false;
  }
}

let binariesReadyPromise = null;

function ensureBinaries() {
  if (binariesReadyPromise) return binariesReadyPromise;

  binariesReadyPromise = (async () => {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const arch = process.arch;

    // 1. Ensure yt-dlp is present
    let currentYtdlp = resolveBinary('yt-dlp');
    if (!fs.existsSync(currentYtdlp)) {
      console.log(`[Auto-Setup] yt-dlp missing on ${process.platform} (${arch}). Auto-downloading standalone binary...`);
      let ytdlpUrl = '';
      if (isWin) {
        ytdlpUrl = arch === 'arm64'
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_arm64.exe'
          : (arch === 'ia32'
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_x86.exe'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
      } else if (isMac) {
        ytdlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
      } else {
        // Linux: Standalone binary with bundled Python
        ytdlpUrl = (arch === 'arm64' || arch === 'aarch64')
          ? 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux_aarch64'
          : 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux';
      }

      const target = path.join(BIN_DIR, isWin ? 'yt-dlp.exe' : 'yt-dlp');
      try {
        await downloadFile(ytdlpUrl, target);
      } catch (err) {
        if (!isWin) {
          try {
            await downloadFile('https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp', target);
          } catch (_) {}
        }
      }

      if (fs.existsSync(target)) {
        if (!isWin) try { fs.chmodSync(target, 0o755); } catch (_) {}
        YTDLP = target;
        console.log(`[Auto-Setup] yt-dlp successfully installed: ${target}`);
      }
    } else {
      YTDLP = currentYtdlp;
    }

    // 2. Ensure ffmpeg is present
    let currentFfmpeg = resolveBinary('ffmpeg');
    if (!fs.existsSync(currentFfmpeg)) {
      console.log(`[Auto-Setup] ffmpeg missing on ${process.platform} (${arch}). Auto-downloading static bundle...`);
      let ffmpegZipUrl = '';
      if (isWin) {
        ffmpegZipUrl = arch === 'ia32'
          ? 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-win-32.zip'
          : 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-win-64.zip';
      } else if (isMac) {
        ffmpegZipUrl = 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-osx-64.zip';
      } else {
        ffmpegZipUrl = (arch === 'arm64' || arch === 'aarch64')
          ? 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-linux-arm-64.zip'
          : (arch === 'arm'
            ? 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-linux-armhf-32.zip'
            : 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-linux-64.zip');
      }

      const zipPath = path.join(BIN_DIR, 'ffmpeg-temp.zip');
      try {
        await downloadFile(ffmpegZipUrl, zipPath);
        extractZip(zipPath, BIN_DIR);
        try { fs.unlinkSync(zipPath); } catch (_) {}
        const extractedFfmpeg = path.join(BIN_DIR, isWin ? 'ffmpeg.exe' : 'ffmpeg');
        if (fs.existsSync(extractedFfmpeg)) {
          if (!isWin) try { fs.chmodSync(extractedFfmpeg, 0o755); } catch (_) {}
          FFMPEG = extractedFfmpeg;
          console.log(`[Auto-Setup] ffmpeg successfully installed: ${extractedFfmpeg}`);
        }
      } catch (err) {
        console.warn('[Auto-Setup] Could not auto-download ffmpeg:', err.message);
      }
    } else {
      FFMPEG = currentFfmpeg;
    }

    // 3. Ensure ffprobe is present
    const ffprobeName = isWin ? 'ffprobe.exe' : 'ffprobe';
    const localFfprobe = path.join(BIN_DIR, ffprobeName);
    if (!fs.existsSync(localFfprobe) && !resolveBinary('ffprobe')) {
      let ffprobeZipUrl = '';
      if (isWin) {
        ffprobeZipUrl = arch === 'ia32'
          ? 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffprobe-4.4.1-win-32.zip'
          : 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffprobe-4.4.1-win-64.zip';
      } else if (isMac) {
        ffprobeZipUrl = 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffprobe-4.4.1-osx-64.zip';
      } else {
        ffprobeZipUrl = (arch === 'arm64' || arch === 'aarch64')
          ? 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffprobe-4.4.1-linux-arm-64.zip'
          : 'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffprobe-4.4.1-linux-64.zip';
      }
      if (ffprobeZipUrl) {
        const probeZipPath = path.join(BIN_DIR, 'ffprobe-temp.zip');
        try {
          await downloadFile(ffprobeZipUrl, probeZipPath);
          extractZip(probeZipPath, BIN_DIR);
          try { fs.unlinkSync(probeZipPath); } catch (_) {}
          if (!isWin && fs.existsSync(localFfprobe)) {
            try { fs.chmodSync(localFfprobe, 0o755); } catch (_) {}
          }
        } catch (_) {}
      }
    }

    autoUpdateYtdlp();
  })();

  return binariesReadyPromise;
}

ensureBinaries().catch(() => {});
setInterval(() => autoUpdateYtdlp(true), 6 * 3600 * 1000);

function getFfmpegDir() {
  const binary = resolveBinary('ffmpeg') || FFMPEG;
  if (binary && fs.existsSync(binary)) {
    return fs.statSync(binary).isDirectory() ? binary : path.dirname(binary);
  }
  return BIN_DIR;
}

const DEFAULT_QUERY = process.env.DEFAULT_QUERY || '';
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '3', 10);
const SEARCH_PAGE_SIZE = 24;
const MAX_SEARCH_PAGES = 20;

const { Innertube, UniversalCache, Platform, Log } = require('youtubei.js');
Log.setLevel(Log.Level.NONE);
Platform.shim.eval = async (d) => new Function(d.output)();

function getCookiesPath() {
  if (process.env.YT_COOKIES && fs.existsSync(process.env.YT_COOKIES)) return process.env.YT_COOKIES;
  const local = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(local) && fs.statSync(local).size > 100) return local;
  return '';
}

function resolvePython() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;
  const isWin = process.platform === 'win32';
  try {
    const cmd = isWin ? 'where.exe python.exe' : 'which python3 || which python';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}
  return isWin ? 'python.exe' : 'python3';
}

function syncCookiesFromBrowser(force = false) {
  const local = path.join(__dirname, 'cookies.txt');
  if (!force && fs.existsSync(local) && (Date.now() - fs.statSync(local).mtimeMs < 6 * 3600 * 1000)) return;

  const ytdlpBin = resolveBinary('yt-dlp');
  if (ytdlpBin && fs.existsSync(ytdlpBin)) {
    for (const browser of ['brave', 'chrome', 'edge', 'firefox']) {
      try {
        const p = spawn(ytdlpBin, ['--cookies-from-browser', browser, '--cookies', local, '--skip-download', 'https://www.youtube.com'], {
          cwd: __dirname,
          windowsHide: true,
          stdio: 'ignore'
        });
        p.on('close', code => {
          if (code === 0 && fs.existsSync(local) && fs.statSync(local).size > 100) {
            innertubePromise = null;
          }
        });
        break;
      } catch (_) {}
    }
  } else {
    const pyScript = `
import yt_dlp
for b in ['brave', 'chrome', 'edge', 'firefox']:
    try:
        ydl_opts = {'cookiesfrombrowser': (b, None, None, None), 'cookiefile': 'cookies.txt', 'quiet': True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.cookiejar.save('cookies.txt', ignore_discard=True, ignore_expires=True)
            break
    except Exception:
        continue
`;
    const pythonBin = resolvePython();
    try {
      const p = spawn(pythonBin, ['-c', pyScript], { cwd: __dirname, windowsHide: true, stdio: 'ignore' });
      p.on('close', () => { innertubePromise = null; });
    } catch (_) {}
  }
}
syncCookiesFromBrowser();
setInterval(() => syncCookiesFromBrowser(true), 6 * 3600 * 1000);

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    let cookie = '';
    const cookieFile = getCookiesPath();
    if (cookieFile && fs.existsSync(cookieFile)) {
      try {
        const lines = fs.readFileSync(cookieFile, 'utf8').split('\n');
        const pairs = [];
        for (const line of lines) {
          if (!line || line.startsWith('#')) continue;
          const parts = line.split('\t');
          if (parts.length >= 7 && parts[0].includes('youtube.com')) {
            pairs.push(parts[5] + '=' + parts[6].trim());
          }
        }
        cookie = pairs.join('; ');
      } catch (_) {}
    }
    innertubePromise = Innertube.create({
      cache: new UniversalCache(false),
      ...(cookie ? { cookie } : {})
    }).catch(err => {
      innertubePromise = null;
      throw err;
    });
  }
  return innertubePromise;
}

async function extractWithInnertube(id, maxHeight = 720, videoOnly = false) {
  const yt = await getInnertube();
  const clients = ['IOS', 'ANDROID', 'MWEB', 'WEB'];
  for (const client of clients) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const fmts = info.streaming_data?.adaptive_formats || [];
      if (!fmts.length) continue;

      const vFmts = fmts
        .filter(f => f.has_video && (!f.height || f.height <= maxHeight))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      if (!vFmts.length) continue;

      const vChoice = vFmts.find(f => (f.mime_type || '').includes('avc1') || (f.mime_type || '').includes('mp4')) || vFmts[0];
      const vUrl = await vChoice.decipher(yt.session.player);
      if (!vUrl) continue;
      if (videoOnly) return [vUrl];

      const aFmts = fmts
        .filter(f => f.has_audio)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (aFmts.length) {
        const aChoice = aFmts.find(f => (f.mime_type || '').includes('mp4a') || (f.mime_type || '').includes('aac')) || aFmts[0];
        const aUrl = await aChoice.decipher(yt.session.player);
        if (aUrl) return [vUrl, aUrl];
      }
      return [vUrl];
    } catch (_) {}
  }
  return null;
}

async function getInnertubeInfo(id) {
  const yt = await getInnertube();
  const clients = ['ANDROID', 'MWEB', undefined];
  let info = null;
  for (const client of clients) {
    try {
      info = await yt.getBasicInfo(id, client ? { client } : {});
      if (info && info.streaming_data) break;
    } catch (_) {}
  }
  if (!info || !info.streaming_data) throw new Error('Could not fetch video info from Innertube');

  const fmts = [
    ...(info.streaming_data?.formats || []),
    ...(info.streaming_data?.adaptive_formats || []),
  ];
  const byHeight = new Map();
  for (const f of fmts) {
    if (f.has_video && f.height && f.height >= 144) {
      byHeight.set(f.height, Math.max(byHeight.get(f.height) || 0, Number(f.content_length || 0)));
    }
  }
  const video = [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([h, s]) => ({
    height: h, label: h + 'p' + (h >= 4320 ? ' (8K)' : h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h >= 1080 ? ' (HD)' : ''),
    size: s ? Number(s) : null,
  }));
  const playbackQualities = [...byHeight.keys()].sort((a, b) => b - a);
  const audio = [
    { q: 'mp3-320', label: 'MP3 · 320 kbps' },
    { q: 'mp3-192', label: 'MP3 · 192 kbps' },
    { q: 'mp3-128', label: 'MP3 · 128 kbps' },
    { q: 'm4a', label: 'M4A · Best (AAC)' },
    { q: 'opus', label: 'OPUS · Best quality' },
  ];
  return {
    id,
    title: info.basic_info?.title || 'YouTube Video',
    duration: info.basic_info?.duration || 0,
    video,
    audio,
    playbackQualities,
  };
}

async function getFastVideoInfo(id) {
  return new Promise((resolve) => {
    const req = https.get(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const m = data.match(/var ytInitialPlayerResponse\s*=\s*({.+?});<\/script>/) ||
                    data.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
          if (!m) return resolve(null);
          const json = JSON.parse(m[1]);
          const details = json.videoDetails || {};
          const streaming = json.streamingData || {};
          const fmts = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])];
          if (!fmts.length) return resolve(null);

          const audioFmts = fmts.filter(f => f.mimeType && f.mimeType.startsWith('audio/'));
          const maxAudioSize = Math.max(0, ...audioFmts.map(f => Number(f.contentLength || 0)));

          const byHeight = new Map();
          for (const f of fmts) {
            if (!f.height || f.height < 144) continue;
            const size = Number(f.contentLength || 0);
            const current = byHeight.get(f.height) || { size: 0, fps: 30 };
            if (size > current.size) {
              byHeight.set(f.height, {
                size,
                fps: f.fps || 30,
              });
            }
          }

          const video = [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([h, meta]) => {
            let tag = '';
            if (h >= 8640) tag = ' (16K)';
            else if (h >= 4320) tag = ' (8K)';
            else if (h >= 2160) tag = ' (4K)';
            else if (h >= 1440) tag = ' (2K)';
            else if (h >= 1080) tag = ' (HD)';
            return {
              height: h,
              label: `${h}p${tag}`,
              size: meta.size ? meta.size + maxAudioSize : null,
              fps: meta.fps,
            };
          });

          const audio = [
            { q: 'mp3-320', label: 'MP3 · 320 kbps' },
            { q: 'mp3-192', label: 'MP3 · 192 kbps' },
            { q: 'mp3-128', label: 'MP3 · 128 kbps' },
            { q: 'm4a', label: 'M4A · Best (AAC)' },
            { q: 'opus', label: 'OPUS · Best quality' },
          ];

          resolve({
            id,
            title: details.title || 'YouTube Video',
            duration: Number(details.lengthSeconds || 0),
            video,
            audio,
            playbackQualities: video.map(v => v.height),
          });
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const VAST_HOME_CATEGORIES = [
  // 1. Trending Hindi & Bollywood Hits
  ['trending hindi songs official video', 'bollywood hit songs 2026', 'arijit singh new song official', 'shreya ghoshal songs'],
  // 2. Trending Punjabi & Regional Hits
  ['latest punjabi songs official video', 'diljit dosanjh official song', 'karan aujla music video', 'ap dhillon tracks', 'sidhu moosewala official'],
  // 3. Global Pop & Billboard Hot 100
  ['billboard hot 100 official music video', 'the weeknd official video', 'taylor swift bruno mars songs', 'dua lipa billie eilish video'],
  // 4. Technology & Science
  ['latest tech smartphone review', 'futuristic tech innovations mkbhd', 'veritasium science discovery'],
  // 5. Gaming & Esports
  ['gaming highlights viral moments', 'minecraft gta epic clips', 'top esports moments 2026'],
  // 6. Viral Entertainment & Comedy
  ['stand up comedy viral video', 'trending entertainment clips', 'viral funny moments youtube'],
  // 7. Movie Trailers & Blockbuster Teasers
  ['official movie trailer 2026', 'new blockbuster trailer teaser official']
];

function isSongEntry(e) {
  const title = (e.title || '').toLowerCase();
  const channel = (e.channel || e.uploader || '').toLowerCase();
  const dur = Number(e.duration) || 0;

  const hasSongKeywords = /\b(official\s*(music\s*)?video|audio|song|music|track|lyrics|lyric\s*video|single|remix|acoustic|feat|ft\.)\b/i.test(title);
  const hasMusicChannel = /\b(records?|music|vevo|t-series|zee\s*music|sony\s*music|yrf|speed\s*records|white\s*hill|geet\s*mp3|tips|saregama)\b/i.test(channel);
  const isReasonableSongLength = dur >= 60 && dur <= 660; // 1 to 11 minutes

  return (hasSongKeywords || hasMusicChannel) && isReasonableSongLength;
}

function rankSearchResults(rawEntries) {
  const songs = [];
  const others = [];

  for (const e of rawEntries) {
    if (isSongEntry(e)) songs.push(e);
    else others.push(e);
  }

  // Top 10 slots strictly prioritize official songs & music tracks
  const top10 = songs.slice(0, 10);
  const remainingSongs = songs.slice(10);

  if (top10.length < 10) {
    const needed = 10 - top10.length;
    top10.push(...others.splice(0, needed));
  }

  // Remainder: Interleave songs with other diverse results (live, covers, reactions, podcasts)
  const mixedRemainder = [];
  const maxLen = Math.max(remainingSongs.length, others.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < remainingSongs.length) mixedRemainder.push(remainingSongs[i]);
    if (i < others.length) mixedRemainder.push(others[i]);
  }

  return [...top10, ...mixedRemainder];
}
const MIX_TITLE_RE = /\b(playlist|mix(?:es)?|medley|mash[\s-]?up|non[\s-]?stop|jukebox|compilation|full album|top\s+\d+\s+songs|best songs|lofi mix|song collection)\b/i;
const TMP = path.join(os.tmpdir(), 'tubegrab');
fs.mkdirSync(TMP, { recursive: true });

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/debug', async (req, res) => {
  const binary = resolveBinary('yt-dlp') || YTDLP;
  let version = '', versionErr = '';
  try {
    version = execSync(`"${binary}" --version`, { encoding: 'utf8' }).trim();
  } catch (e) { versionErr = e.message; }

  let innerStatus = 'pending', innerUrl = '', innerErr = '';
  try {
    const yt = await getInnertube();
    const info = await yt.getBasicInfo('cl0a3i2wFcc', { client: 'ANDROID' });
    const fmts = info.streaming_data?.formats || [];
    if (fmts.length) {
      const f = fmts.find(x => x.itag === 18) || fmts[0];
      innerUrl = await f.decipher(yt.session.player);
      innerStatus = 'ok';
    } else {
      innerStatus = 'no formats';
    }
  } catch (e) {
    innerStatus = 'error';
    innerErr = e.message;
  }

  res.json({
    deployTime: '2026-10-17-09:46',
    ytdlp: { path: binary, version, error: versionErr },
    innertube: { status: innerStatus, hasUrl: !!innerUrl, error: innerErr }
  });
});

// Secret API Key Guard: Enforces authorization if API_SECRET_KEY is set in .env
app.use('/api', (req, res, next) => {
  if (!API_SECRET_KEY) return next();
  const isLoopback = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (isLoopback) return next();
  const token = req.headers['x-api-key'] ||
                (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
                req.query.key;
  if (token && token === API_SECRET_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
});

const baseArgs = (noPlaylist = true) => {
  const a = [
    '--no-warnings',
    '--socket-timeout', '20',
  ];
  if (noPlaylist) a.push('--no-playlist');
  const cookiePath = getCookiesPath();
  if (cookiePath) a.push('--cookies', cookiePath);
  return a;
};

async function runJson(args, noPlaylist = true) {
  await ensureBinaries();
  const binary = resolveBinary('yt-dlp') || YTDLP;
  return new Promise((resolve, reject) => {
    const p = spawn(binary, [...baseArgs(noPlaylist), ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', () => reject(new Error('yt-dlp is not available')));
    p.on('close', code => {
      if (code !== 0) {
        if (/extractor|signature|player|cipher|confirm you’re not a bot|login|unable to extract/i.test(err)) {
          autoUpdateYtdlp(true);
        }
        return reject(new Error(err.trim().split('\n').pop() || 'yt-dlp failed'));
      }
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

async function runLines(args) {
  await ensureBinaries();
  const binary = resolveBinary('yt-dlp') || YTDLP;
  return new Promise((resolve, reject) => {
    const p = spawn(binary, [...baseArgs(), ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', () => reject(new Error('yt-dlp is not available')));
    p.on('close', code => {
      if (code !== 0) {
        if (/extractor|signature|player|cipher|confirm you’re not a bot|login|unable to extract/i.test(err)) {
          autoUpdateYtdlp(true);
        }
        return reject(new Error(err.trim().split('\n').pop() || 'yt-dlp failed'));
      }
      resolve(out.trim().split(/\r?\n/).filter(Boolean));
    });
  });
}

// ---------- small cache ----------
const cache = new Map();
const cached = async (key, ttlMs, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const pending = Promise.resolve().then(fn).then(v => {
    if (cache.get(key)?.v === pending) cache.set(key, { t: Date.now(), v });
    return v;
  }).catch(e => {
    if (cache.get(key)?.v === pending) cache.delete(key);
    throw e;
  });
  cache.set(key, { t: Date.now(), v: pending });
  return pending;
};

// ---------- search / home feed ----------
let homeFeedPool = [];
let homeShortsPool = [];
let homeFeedTime = 0;
const HOME_CACHE_TTL = 15 * 60 * 1000;

async function fetchCategoryBatch(query, limit = 12) {
  try {
    const d = await runJson(['--flat-playlist', '-J', `ytsearch${limit}:${query}`], false);
    return (d.entries || []).filter(e => e && ID_RE.test(e.id) && !MIX_TITLE_RE.test(e.title || ''));
  } catch (_) {
    return [];
  }
}

async function getHomeFeedVideos() {
  if (homeFeedPool.length >= 36 && Date.now() - homeFeedTime < HOME_CACHE_TTL) {
    return { videos: homeFeedPool, shorts: homeShortsPool };
  }
  try {
    const selectedQueries = VAST_HOME_CATEGORIES.map(cat => cat[Math.floor(Math.random() * cat.length)]);
    const shortsQuery = 'trending funny viral shorts #shorts';

    const [catResults, shortsResult] = await Promise.all([
      Promise.all(selectedQueries.map(q => fetchCategoryBatch(q, 10))),
      fetchCategoryBatch(shortsQuery, 12)
    ]);

    const interleaved = [];
    const maxItems = Math.max(0, ...catResults.map(r => r.length));
    for (let i = 0; i < maxItems; i++) {
      for (const cat of catResults) {
        if (cat[i]) interleaved.push(cat[i]);
      }
    }

    if (interleaved.length > 0) {
      homeFeedPool = interleaved.map(item => ({
        id: item.id,
        title: item.title,
        channel: item.channel || item.uploader,
        duration: item.duration,
        views: item.view_count,
        thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      }));
      homeShortsPool = shortsResult.slice(0, 8).map(item => ({
        id: item.id,
        title: item.title,
        channel: item.channel || item.uploader,
        duration: item.duration,
        views: item.view_count,
        thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
        isShort: true,
      }));
      homeFeedTime = Date.now();
    }
  } catch (err) {
    console.warn('[HomeFeed] Error fetching:', err.message);
  }
  return { videos: homeFeedPool, shorts: homeShortsPool };
}

app.get('/api/search', async (req, res) => {
  const requestedQuery = String(req.query.q || '').slice(0, 200).trim();
  const isHomeFeed = !requestedQuery;
  const feedSeed = String(req.query.feed || '').slice(0, 80) || crypto.randomBytes(12).toString('hex');
  const excludedIds = isHomeFeed
    ? new Set(String(req.query.exclude || '').split(',').filter(id => ID_RE.test(id)))
    : new Set();
  const page = Number(req.query.page || 0);
  if (!Number.isInteger(page) || page < 0 || page >= MAX_SEARCH_PAGES)
    return res.status(400).json({ error: 'bad page' });
  const end = (page + 1) * SEARCH_PAGE_SIZE;

  try {
    if (isHomeFeed) {
      const { videos: pool, shorts } = await getHomeFeedVideos();
      let list = pool.filter(v => !excludedIds.has(v.id));
      if (list.length < SEARCH_PAGE_SIZE) {
        list = pool;
      }
      const results = list.slice(page * SEARCH_PAGE_SIZE, end);
      return res.json({
        results,
        shorts: page === 0 ? shorts : [],
        hasMore: list.length > end && page + 1 < MAX_SEARCH_PAGES
      });
    }

    // User Search Query: YouTube-style ranking
    const cacheKey = `s:${requestedQuery}:${end}`;
    const entries = await cached(cacheKey, 5 * 60e3, async () => {
      const count = Math.min(100, Math.max(40, end + 10));
      const d = await runJson(['--flat-playlist', '-J', `ytsearch${count}:${requestedQuery}`], false);
      const rawEntries = (d.entries || []).filter(e => e && ID_RE.test(e.id));
      const ranked = rankSearchResults(rawEntries);

      return ranked.map(e => ({
        id: e.id,
        title: e.title,
        channel: e.channel || e.uploader,
        duration: e.duration,
        views: e.view_count,
        thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      }));
    });
    const results = entries.slice(page * SEARCH_PAGE_SIZE, end);
    res.json({ results, hasMore: entries.length > end && page + 1 < MAX_SEARCH_PAGES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- available formats for one video ----------
app.get('/api/info', async (req, res) => {
  const id = String(req.query.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const info = await cached('i:' + id, 10 * 60e3, async () => {
      // 1. Instant 800ms extraction directly from YouTube watch page
      const fast = await getFastVideoInfo(id);
      if (fast && fast.video && fast.video.length > 0) {
        return fast;
      }

      // 2. Try Innertube
      try {
        const inner = await getInnertubeInfo(id);
        if (inner && inner.video && inner.video.length > 0) return inner;
      } catch (_) {}

      // 3. Fallback to runJson
      let raw = null;
      try {
        raw = await runJson(['-J', 'https://www.youtube.com/watch?v=' + id]);
      } catch (_) {}

      if (raw) {
        const fmts = raw.formats || [];
        const audioSize = Math.max(0, ...fmts.filter(f => f.vcodec === 'none' && f.acodec !== 'none')
          .map(f => f.filesize || f.filesize_approx || 0));
        const byHeight = new Map();
        for (const f of fmts) {
          if (!f.vcodec || f.vcodec === 'none' || !f.height || f.height < 144) continue;
          if (f.protocol === 'mhtml' || f.ext === 'mhtml') continue;
          if (typeof f.format_note === 'string' && f.format_note.toLowerCase().includes('storyboard')) continue;
          const size = f.filesize || f.filesize_approx || 0;
          byHeight.set(f.height, Math.max(byHeight.get(f.height) || 0, size));
        }
        const video = [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([h, s]) => {
          let tag = '';
          if (h >= 8640) tag = ' (16K)';
          else if (h >= 4320) tag = ' (8K)';
          else if (h >= 2160) tag = ' (4K)';
          else if (h >= 1440) tag = ' (2K)';
          else if (h >= 1080) tag = ' (HD)';
          return {
            height: h,
            label: `${h}p${tag}`,
            size: s ? s + audioSize : null,
          };
        });

        const audio = [
          { q: 'mp3-320', label: 'MP3 · 320 kbps' },
          { q: 'mp3-192', label: 'MP3 · 192 kbps' },
          { q: 'mp3-128', label: 'MP3 · 128 kbps' },
          { q: 'm4a', label: 'M4A · Best (AAC)' },
          { q: 'opus', label: 'OPUS · Best quality' },
        ];

        return {
          id,
          title: raw.title || 'YouTube Video',
          duration: raw.duration || 0,
          video: video.length ? video : [
            { height: 4320, label: '4320p (8K)', size: null },
            { height: 2160, label: '2160p (4K)', size: null },
            { height: 1440, label: '1440p (2K)', size: null },
            { height: 1080, label: '1080p (HD)', size: null },
            { height: 720, label: '720p', size: null },
            { height: 480, label: '480p', size: null },
            { height: 360, label: '360p', size: null },
          ],
          audio,
          playbackQualities: video.map(v => v.height),
        };
      }

      // 4. Default fallback with full resolution spectrum
      return {
        id,
        title: 'YouTube Video',
        duration: 0,
        video: [
          { height: 4320, label: '4320p (8K)', size: null },
          { height: 2160, label: '2160p (4K)', size: null },
          { height: 1440, label: '1440p (2K)', size: null },
          { height: 1080, label: '1080p (HD)', size: null },
          { height: 720, label: '720p', size: null },
          { height: 480, label: '480p', size: null },
          { height: 360, label: '360p', size: null },
        ],
        audio: [
          { q: 'mp3-320', label: 'MP3 · 320 kbps' },
          { q: 'mp3-192', label: 'MP3 · 192 kbps' },
          { q: 'mp3-128', label: 'MP3 · 128 kbps' },
          { q: 'm4a', label: 'M4A · Best (AAC)' },
          { q: 'opus', label: 'OPUS · Best quality' },
        ],
        playbackQualities: [4320, 2160, 1440, 1080, 720, 360],
      };
    });
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- high-speed direct CDN streaming proxy with HTTP Range support ----------
async function getDirectStreamUrl(id) {
  // 1. In-process Innertube (instant, 200ms in-memory decipher, bypasses cloud IP limits)
  try {
    const yt = await getInnertube();
    for (const client of ['ANDROID', 'MWEB']) {
      try {
        const info = await yt.getBasicInfo(id, { client });
        const formats = info.streaming_data?.formats || [];
        if (formats.length) {
          const f = formats.find(fmt => fmt.itag === 18) || formats[0];
          const url = await f.decipher(yt.session.player);
          if (url && url.startsWith('http')) return url;
        }
      } catch (_) {}
    }
  } catch (innerErr) {
    console.warn('[Stream] Innertube direct URL failed, falling back to yt-dlp:', innerErr.message);
  }

  // 2. Fallback to yt-dlp with android,mweb client
  const lines = await runLines(['-f', '18/best', '-g', `https://www.youtube.com/watch?v=${id}`]);
  if (lines.length && lines[0].startsWith('http')) return lines[0];
  throw new Error('No stream URL available');
}

app.get('/api/preload/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const urlKey = 'stream_url:' + id;
  try {
    await cached(urlKey, 60 * 60 * 1000, () => getDirectStreamUrl(id));
    return res.json({ status: 'ready', cached: true, totalBytes: 10 * 1024 * 1024 });
  } catch (_) {
    return res.json({ status: 'ready', cached: false, totalBytes: 0 });
  }
});

app.get('/api/preload/status/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const urlKey = 'stream_url:' + id;
  const isReady = cache.has(urlKey);
  return res.json({ status: isReady ? 'ready' : 'idle', cached: isReady, totalBytes: isReady ? 10 * 1024 * 1024 : 0 });
});

app.get('/api/stream/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });

  try {
    const urlKey = 'stream_url:' + id;
    let streamUrl = await cached(urlKey, 60 * 60 * 1000, () => getDirectStreamUrl(id));

    const headers = {};
    if (req.headers.range) {
      headers.range = req.headers.range;
    }
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

    const pipeStream = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 3) {
        if (!res.headersSent) res.status(502).json({ error: 'Too many redirects' });
        return;
      }
      const client = targetUrl.startsWith('https') ? https : http;
      const proxyReq = client.get(targetUrl, { headers }, proxyRes => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
          return pipeStream(proxyRes.headers.location, redirectCount + 1);
        }
        if (proxyRes.statusCode === 403) {
          cache.delete(urlKey);
          if (!res.headersSent) res.status(502).json({ error: 'Stream token expired. Please retry.' });
          return;
        }

        const responseHeaders = {
          'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
        if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', err => {
        if (!res.headersSent) res.status(502).json({ error: err.message });
      });

      req.on('close', () => {
        proxyReq.destroy();
      });
    };

    pipeStream(streamUrl);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ---------- download jobs & fair-usage round-robin queue ----------
const jobs = new Map();
const downloadQueue = []; // FIFO array of queued job IDs
let rrClientIndex = 0;    // Pointer for round-robin client scheduling

const MAX_GLOBAL_JOBS = parseInt(process.env.MAX_JOBS || '3', 10);
const MAX_ACTIVE_PER_CLIENT = 2; // User can run maximum 2 downloads concurrently
const MAX_TOTAL_PER_CLIENT = 3;  // User can have maximum 3 downloads in progress (active + queued)
const MAX_WAITING_QUEUE = 60;    // Backpressure limit to prevent memory issues under traffic spikes

function getClientKey(req) {
  const clientHeader = req.headers['x-client-id'];
  if (clientHeader && typeof clientHeader === 'string' && clientHeader.trim().length >= 4) {
    return clientHeader.trim().slice(0, 64);
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

function getClientJobCounts(clientKey) {
  let active = 0;
  let queued = 0;
  for (const j of jobs.values()) {
    if (j.clientKey === clientKey) {
      if (j.status === 'running') active++;
      else if (j.status === 'queued') queued++;
    }
  }
  return { active, queued, total: active + queued };
}

function countRunningJobs() {
  let count = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running') count++;
  }
  return count;
}

function updateQueuePositions() {
  for (let i = 0; i < downloadQueue.length; i++) {
    const j = jobs.get(downloadQueue[i]);
    if (j && j.status === 'queued') {
      j.queuePosition = i + 1;
      j.stage = `In queue (#${i + 1} in line)`;
    }
  }
}

function dispatchNextQueuedJob() {
  while (countRunningJobs() < MAX_GLOBAL_JOBS && downloadQueue.length > 0) {
    // Collect distinct clients with jobs in queue
    const clientsInQueue = [];
    for (const id of downloadQueue) {
      const j = jobs.get(id);
      if (j && j.status === 'queued' && !clientsInQueue.includes(j.clientKey)) {
        clientsInQueue.push(j.clientKey);
      }
    }
    if (!clientsInQueue.length) {
      downloadQueue.length = 0;
      break;
    }

    // Round-Robin selection: find next eligible client with active < MAX_ACTIVE_PER_CLIENT
    let selectedJobId = null;
    const numClients = clientsInQueue.length;
    for (let i = 0; i < numClients; i++) {
      const client = clientsInQueue[(rrClientIndex + i) % numClients];
      const counts = getClientJobCounts(client);
      if (counts.active < MAX_ACTIVE_PER_CLIENT) {
        const idx = downloadQueue.findIndex(id => {
          const j = jobs.get(id);
          return j && j.clientKey === client && j.status === 'queued';
        });
        if (idx !== -1) {
          selectedJobId = downloadQueue.splice(idx, 1)[0];
          rrClientIndex = (rrClientIndex + i + 1) % numClients;
          break;
        }
      }
    }

    // If all waiting clients are already using their MAX_ACTIVE_PER_CLIENT limit, stop
    if (!selectedJobId) break;

    const jobToStart = jobs.get(selectedJobId);
    if (jobToStart && jobToStart.status === 'queued') {
      jobToStart.status = 'running';
      jobToStart.queuePosition = 0;
      startDownloadAttempt(selectedJobId, jobToStart);
    }
  }
  updateQueuePositions();
}

const DOWNLOAD_RETRY_ARGS = [
  '--continue',
  '--retries', '10',
  '--fragment-retries', '10',
  '--extractor-retries', '5',
  '--retry-sleep', 'http:exp=1:20',
  '--retry-sleep', 'fragment:exp=1:20',
  '--retry-sleep', 'extractor:exp=1:10',
];
const MAX_DOWNLOAD_ATTEMPTS = 4;
const AUDIO = {
  'mp3-320': ['-x', '--audio-format', 'mp3', '--audio-quality', '320K'],
  'mp3-192': ['-x', '--audio-format', 'mp3', '--audio-quality', '192K'],
  'mp3-128': ['-x', '--audio-format', 'mp3', '--audio-quality', '128K'],
  'm4a':     ['-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a'],
  'opus':    ['-f', 'ba', '-x', '--audio-format', 'opus'],
};
const rmDir = d => fs.rm(d, { recursive: true, force: true }, () => {});

function getDownloadArgs(kind, q) {
  let args;
  if (kind === 'video') {
    const h = parseInt(q, 10);
    if (!(h >= 100 && h <= 8640)) return null;
    args = [
      '-f', `bv*[height=${h}]+ba/bv*[height<=${h}]+ba/bestvideo[height<=${h}]+bestaudio/best`,
      '-S', `res:${h}`,
      '--merge-output-format', 'mp4',
    ];
  } else if (kind === 'audio' && AUDIO[q]) {
    args = AUDIO[q];
  } else return null;
  return args;
}

function isTransientDownloadError(message) {
  return /(temporary|timed?\s*out|timeout|connection|network|resolve|dns|name or service not known|temporary failure|http error 5\d\d|http error 429|giving up after \d+ retries)/i.test(message);
}

async function startDownloadAttempt(jobId, job, attempt = 1) {
  job.status = 'running';
  job.attempt = attempt;
  job.stage = attempt === 1 ? 'Starting' : `Retrying connection (${attempt}/${MAX_DOWNLOAD_ATTEMPTS})`;
  let err = '';
  let settled = false;
  const finishAttempt = (code, spawnError) => {
    if (settled) return;
    settled = true;
    if (spawnError) err = 'yt-dlp could not be started';
    const mediaExts = /\.(mp4|webm|mkv|mp3|m4a|opus|ogg|flac|wav|aac)$/i;
    let files = [];
    try {
      files = fs.readdirSync(job.dir)
        .filter(f => !/\.(part|ytdl|temp)$/.test(f))
        .map(f => ({ f, s: fs.statSync(path.join(job.dir, f)).size }))
        .filter(file => file.s > 0)
        .sort((a, b) => b.s - a.s);
    } catch (_) {}

    const mediaFiles = files.filter(file => mediaExts.test(file.f));
    const targetFile = mediaFiles.length ? mediaFiles[0].f : (files[0] ? files[0].f : null);

    if (code === 0 && targetFile) {
      job.status = 'done';
      job.progress = 100;
      job.stage = 'Completed';
      job.file = targetFile;
      job.completed = Date.now();
      dispatchNextQueuedJob();
      return;
    }

    const message = err.trim().split('\n').filter(Boolean).pop() || 'Download failed';
    job.lastError = message;
    if (!spawnError && attempt < MAX_DOWNLOAD_ATTEMPTS && isTransientDownloadError(err)) {
      const delay = Math.min(15000, 2000 * (2 ** (attempt - 1)));
      job.stage = `Retrying connection (${attempt + 1}/${MAX_DOWNLOAD_ATTEMPTS})`;
      job.retryIn = delay;
      setTimeout(() => {
        if (job.status === 'running') startDownloadAttempt(jobId, job, attempt + 1);
      }, delay);
      return;
    }
    if (/extractor|signature|player|cipher|confirm you’re not a bot|login|unable to extract/i.test(err)) {
      autoUpdateYtdlp(true);
    }
    job.status = 'error';
    job.stage = 'Failed';
    job.error = message;
    job.completed = Date.now();
    dispatchNextQueuedJob();
  };

  await ensureBinaries();
  const ytdlpBin = resolveBinary('yt-dlp') || YTDLP;
  const ffmpegDir = getFfmpegDir();

  const pArgs = [
    ...baseArgs(), ...DOWNLOAD_RETRY_ARGS, '--newline', '--concurrent-fragments', '4', '--windows-filenames',
  ];
  if (ffmpegDir) pArgs.push('--ffmpeg-location', ffmpegDir);
  pArgs.push(
    '-o', path.join(job.dir, '%(title).100s.%(ext)s'), ...job.args,
    `https://www.youtube.com/watch?v=${job.videoId}`
  );
  const p = spawn(ytdlpBin, pArgs);
  job.process = p;
  p.stdout.on('data', d => {
    const s = d.toString();
    const m = [...s.matchAll(/\[download\]\s+([\d.]+)%/g)].pop();
    if (m) {
      job.progress = parseFloat(m[1]);
      job.stage = 'Downloading';
    }
    if (/\[(Merger|ExtractAudio|VideoConvertor)\]/.test(s)) {
      job.stage = 'Converting';
      job.progress = 100;
    }
  });
  p.stderr.on('data', d => {
    const text = d.toString();
    err = (err + text).slice(-12000);
    if (isTransientDownloadError(text)) job.stage = `Retrying connection (${attempt}/${MAX_DOWNLOAD_ATTEMPTS})`;
  });
  p.on('error', error => finishAttempt(1, error));
  p.on('close', code => finishAttempt(code));
}

app.post('/api/jobs', (req, res) => {
  const { id, kind, q, title } = req.body || {};
  if (!ID_RE.test(id || '')) return res.status(400).json({ error: 'Invalid video ID.' });
  const args = getDownloadArgs(kind, q);
  if (!args) return res.status(400).json({ error: 'Invalid download format.' });

  const clientKey = getClientKey(req);
  const clientCounts = getClientJobCounts(clientKey);

  // Maximum 3 total downloads in progress per user (active + queued)
  if (clientCounts.total >= MAX_TOTAL_PER_CLIENT) {
    return res.status(429).json({
      error: 'Fair-usage limit reached: You have 3 downloads in progress (maximum 2 active simultaneously). Please wait for an active download to complete.'
    });
  }

  // Global queue limit under extreme traffic spikes
  if (downloadQueue.length >= MAX_WAITING_QUEUE) {
    return res.status(429).json({
      error: 'Cloud processing nodes are currently at peak capacity. Please try again in a few moments.'
    });
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const canStartImmediately = (clientCounts.active < MAX_ACTIVE_PER_CLIENT) &&
                              (countRunningJobs() < MAX_GLOBAL_JOBS) &&
                              (downloadQueue.length === 0);

  const job = {
    id: jobId,
    clientKey,
    status: canStartImmediately ? 'running' : 'queued',
    progress: 0,
    stage: canStartImmediately ? 'Starting' : 'In queue (waiting for slot)',
    dir: jobDir,
    created: Date.now(),
    title: String(title || '').slice(0, 300),
    videoId: id,
    kind,
    quality: String(q),
    args,
    queuePosition: 0,
  };

  jobs.set(jobId, job);

  if (canStartImmediately) {
    startDownloadAttempt(jobId, job);
  } else {
    downloadQueue.push(jobId);
    updateQueuePositions();
  }

  res.json({
    jobId,
    status: job.status,
    queuePosition: job.queuePosition || 0,
    message: job.status === 'queued'
      ? `Download safely placed in queue (#${job.queuePosition}). It will start automatically when an active slot becomes free.`
      : 'Download started.'
  });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Download not found.' });
  if (job.status !== 'error') return res.status(409).json({ error: 'Only failed downloads can be retried.' });

  const clientKey = getClientKey(req);
  job.clientKey = clientKey;
  const clientCounts = getClientJobCounts(clientKey);

  job.error = undefined;
  job.progress = 0;
  job.retryIn = 0;
  job.completed = undefined;

  const canStart = (clientCounts.active < MAX_ACTIVE_PER_CLIENT) && (countRunningJobs() < MAX_GLOBAL_JOBS);
  if (canStart) {
    job.status = 'running';
    job.queuePosition = 0;
    startDownloadAttempt(req.params.id, job);
  } else {
    job.status = 'queued';
    if (!downloadQueue.includes(req.params.id)) downloadQueue.push(req.params.id);
    updateQueuePositions();
  }

  res.json({ jobId: req.params.id, status: job.status });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json({
    status: j.status,
    progress: j.progress,
    stage: j.stage,
    queuePosition: j.queuePosition || 0,
    error: j.error,
    filename: j.file
  });
});

app.get('/api/jobs', (req, res) => {
  const clientKey = getClientKey(req);
  const results = [...jobs.entries()]
    .filter(([_, job]) => !job.clientKey || job.clientKey === clientKey || req.query.all === '1')
    .map(([id, job]) => ({
      id,
      title: job.title,
      kind: job.kind,
      quality: job.quality,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      queuePosition: job.queuePosition || 0,
      error: job.error,
      lastError: job.lastError,
      filename: job.file,
      created: job.created,
      completed: job.completed,
      retryIn: job.retryIn,
    }))
    .sort((a, b) => b.created - a.created);
  res.json({ jobs: results });
});

app.post('/api/jobs/clear', (_req, res) => {
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.status !== 'queued') {
      rmDir(j.dir);
      jobs.delete(id);
    }
  }
  res.json({ ok: true, count: jobs.size });
});

app.delete('/api/jobs', (_req, res) => {
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.status !== 'queued') {
      rmDir(j.dir);
      jobs.delete(id);
    }
  }
  res.json({ ok: true, count: jobs.size });
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });

  const qIdx = downloadQueue.indexOf(req.params.id);
  if (qIdx !== -1) {
    downloadQueue.splice(qIdx, 1);
  }

  if (j.status === 'running') {
    if (j.process && !j.process.killed) {
      try { j.process.kill(); } catch (_) {}
    }
  }

  rmDir(j.dir);
  jobs.delete(req.params.id);
  dispatchNextQueuedJob();

  res.json({ ok: true });
});

app.get('/api/jobs/:id/file', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done' || !j.file) {
    return res.status(404).json({ error: 'Download is not ready yet or has failed.' });
  }
  const filePath = path.join(j.dir, j.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Downloaded file not found on disk.' });
  }
  const ext = path.extname(j.file).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/opus',
    '.ogg': 'audio/ogg',
  };
  const mime = mimeTypes[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.download(filePath, j.file, err => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download delivery failed' });
    }
  });
});

setInterval(() => {
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && Date.now() - (j.completed || j.created) > 24 * 60 * 60e3) {
      rmDir(j.dir);
      jobs.delete(id);
    }
  }
}, 5 * 60e3);

app.use((err, _req, res, _next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Processing temporarily unavailable. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`TubeGrab running → http://localhost:${PORT}`));
