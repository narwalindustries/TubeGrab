const express = require('express');
const { spawn } = require('child_process');
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
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function autoUpdateYtdlp() {
  try {
    const p = spawn(YTDLP, ['-U'], { windowsHide: true });
    let out = '';
    p.stdout?.on('data', d => { out += d; });
    p.stderr?.on('data', d => { out += d; });
    p.on('close', () => {
      const line = out.trim().split(/\r?\n/)[0] || '';
      if (line) console.log(`[Auto-Updater] yt-dlp check: ${line}`);
    });
    p.on('error', () => {});
  } catch (_) {}
}
setTimeout(autoUpdateYtdlp, 3000);
setInterval(autoUpdateYtdlp, 6 * 3600 * 1000);

function getFfmpegDir() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return fs.statSync(process.env.FFMPEG_PATH).isDirectory()
      ? process.env.FFMPEG_PATH
      : path.dirname(process.env.FFMPEG_PATH);
  }
  const wingetDir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links');
  if (fs.existsSync(path.join(wingetDir, 'ffmpeg.exe'))) return wingetDir;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe ffmpeg' : 'which ffmpeg';
    const out = require('child_process').execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return path.dirname(out);
  } catch (_) {}
  return '';
}
const FFMPEG_DIR = getFfmpegDir();
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

function syncCookiesFromBrowser(force = false) {
  const local = path.join(__dirname, 'cookies.txt');
  if (!force && fs.existsSync(local) && (Date.now() - fs.statSync(local).mtimeMs < 6 * 3600 * 1000)) return;
  const pyScript = `
import yt_dlp
for b in ['brave', 'chrome', 'edge', 'firefox']:
    try:
        ydl_opts = {'cookiesfrombrowser': (b, None, None, None), 'cookiefile': 'cookies.txt', 'quiet': True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.cookiejar.save('cookies.txt', ignore_discard=True, ignore_expires=True)
            print(f'Synced cookies from {b}')
            break
    except Exception:
        continue
`;
  const pythonBin = process.platform === 'win32'
    ? 'C:\\Users\\narwa\\AppData\\Local\\Programs\\Python\\Python311\\python.exe'
    : 'python3';
  try {
    const p = spawn(pythonBin, ['-c', pyScript], { cwd: __dirname, windowsHide: true, stdio: 'ignore' });
    p.on('close', () => { innertubePromise = null; });
  } catch (_) {}
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
  const clients = ['VISIONOS', 'ANDROID', 'WEB', 'IOS'];
  for (const client of clients) {
    try {
      const info = await yt.getInfo(id, { client });
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
  const info = await yt.getInfo(id, { client: 'WEB' }).catch(() => yt.getInfo(id, { client: 'VISIONOS' }));
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
    height: h, label: h + 'p' + (h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h >= 1080 ? ' (HD)' : ''),
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
    title: info.basic_info.title,
    duration: info.basic_info.duration,
    video,
    audio,
    playbackQualities,
  };
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('OK'));

// Secret API Key Guard: Enforces authorization if API_SECRET_KEY is set in .env
app.use('/api', (req, res, next) => {
  if (!API_SECRET_KEY) return next();
  const token = req.headers['x-api-key'] ||
                (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
                req.query.key;
  if (token && token === API_SECRET_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
});

const baseArgs = (noPlaylist = true) => {
  const a = ['--no-warnings', '--js-runtimes', 'node'];
  if (noPlaylist) a.push('--no-playlist');
  const cookiePath = getCookiesPath();
  if (cookiePath) a.push('--cookies', cookiePath);
  return a;
};

function runJson(args, noPlaylist = true) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, [...baseArgs(noPlaylist), ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', () => reject(new Error('yt-dlp is not installed or could not be found on PATH')));
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || 'yt-dlp failed'));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function runLines(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, [...baseArgs(), ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', () => reject(new Error('yt-dlp is not installed or could not be found on PATH')));
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || 'yt-dlp failed'));
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
app.get('/api/search', async (req, res) => {
  const requestedQuery = String(req.query.q || '').slice(0, 200).trim();
  const isHomeFeed = !requestedQuery;
  const feedSeed = String(req.query.feed || '').slice(0, 80) || crypto.randomBytes(12).toString('hex');
  const excludedIds = isHomeFeed
    ? new Set(String(req.query.exclude || '').split(',').filter(id => ID_RE.test(id)))
    : new Set();
  const seedNumber = [...feedSeed].reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 0);
  const page = Number(req.query.page || 0);
  if (!Number.isInteger(page) || page < 0 || page >= MAX_SEARCH_PAGES)
    return res.status(400).json({ error: 'bad page' });
  const end = (page + 1) * SEARCH_PAGE_SIZE;
  const excludeKey = isHomeFeed
    ? crypto.createHash('sha1').update([...excludedIds].sort().join(',')).digest('hex').slice(0, 10)
    : '';
  const cacheKey = `s:${isHomeFeed ? `home:${feedSeed}:${excludeKey}` : requestedQuery}:${end}`;
  try {
    const entries = await cached(cacheKey, 5 * 60e3, async () => {
      if (isHomeFeed) {
        // Multi-Genre, Multi-Language Diverse Home Feed
        const numCats = VAST_HOME_CATEGORIES.length;
        const catPromises = [];
        for (let i = 0; i < 4; i++) {
          const catIdx = (seedNumber + i) % numCats;
          const list = VAST_HOME_CATEGORIES[catIdx];
          const query = list[(seedNumber + i) % list.length];
          catPromises.push(
            runJson(['--flat-playlist', '-J', `ytsearch22:${query}`], false)
              .then(d => (d.entries || []).filter(e => e && ID_RE.test(e.id)))
              .catch(() => [])
          );
        }

        const catResults = await Promise.all(catPromises);
        const interleaved = [];
        const seen = new Set(excludedIds);
        const maxPerCat = Math.max(...catResults.map(r => r.length), 0);

        for (let step = 0; step < maxPerCat; step++) {
          for (let c = 0; c < catResults.length; c++) {
            const item = catResults[c][step];
            if (item && !seen.has(item.id) && !MIX_TITLE_RE.test(item.title || '') && (!item.duration || item.duration <= 25 * 60)) {
              seen.add(item.id);
              interleaved.push({
                id: item.id,
                title: item.title,
                channel: item.channel || item.uploader,
                duration: item.duration,
                views: item.view_count,
                thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
              });
            }
          }
        }
        return interleaved;
      }

      // User Search Query: YouTube-style ranking (Song first in top 10, then mixed)
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- available formats for one video ----------
app.get('/api/info', async (req, res) => {
  const id = String(req.query.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const info = await cached('i:' + id, 10 * 60e3, async () => {
      try {
        const raw = await runJson(['-J', 'https://www.youtube.com/watch?v=' + id]);
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
        const video = [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([h, s]) => ({
          height: h, label: h + 'p' + (h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h >= 1080 ? ' (HD)' : ''),
          size: s ? s + audioSize : null,
        }));
        const playableFormats = fmts.filter(f => f.ext === 'mp4' && f.height
          && typeof f.vcodec === 'string' && f.vcodec.startsWith('avc1'));
        const hasDirectFormats = playableFormats.some(f => f.protocol === 'https');
        const playbackQualities = [...new Set(playableFormats
          .filter(f => !hasDirectFormats || f.protocol === 'https')
          .map(f => f.height))].sort((a, b) => b - a);
        const audio = [
          { q: 'mp3-320', label: 'MP3 · 320 kbps' },
          { q: 'mp3-192', label: 'MP3 · 192 kbps' },
          { q: 'mp3-128', label: 'MP3 · 128 kbps' },
          { q: 'm4a', label: 'M4A · Best (AAC)' },
          { q: 'opus', label: 'OPUS · Best quality' },
        ];
        return { id, title: raw.title, duration: raw.duration, video, audio, playbackQualities };
      } catch (err) {
        return getInnertubeInfo(id);
      }
    });
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- RAM video stream cache with HTTP Range support & memory safety ----------
const ramStreamCache = new Map();
const MAX_RAM_STREAMS = 6;
const MAX_RAM_BYTES = 120 * 1024 * 1024; // 120MB maximum RAM buffer cache to prevent crashes on limited memory
const RAM_STREAM_TTL = 30 * 60 * 1000;
let currentRamBytes = 0;

function getCachedRamStream(key) {
  const item = ramStreamCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > RAM_STREAM_TTL) {
    if (item.buffer) currentRamBytes -= item.buffer.length;
    ramStreamCache.delete(key);
    return null;
  }
  item.time = Date.now();
  return item.buffer;
}

function saveRamStream(key, buffer) {
  if (!buffer || buffer.length < 50000) return;
  while (ramStreamCache.size >= MAX_RAM_STREAMS || (currentRamBytes + buffer.length > MAX_RAM_BYTES && ramStreamCache.size > 0)) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [k, v] of ramStreamCache.entries()) {
      if (v.time < oldestTime) {
        oldestTime = v.time;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const evicted = ramStreamCache.get(oldestKey);
      if (evicted && evicted.buffer) currentRamBytes -= evicted.buffer.length;
      ramStreamCache.delete(oldestKey);
    } else break;
  }
  currentRamBytes += buffer.length;
  ramStreamCache.set(key, { buffer, time: Date.now() });
}

function serveStreamBuffer(req, res, buffer) {
  const total = buffer.length;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (start >= total || end >= total || start > end) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    const chunk = buffer.subarray(start, end + 1);
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunk.length,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(chunk);
  } else {
    res.status(200).set({
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buffer);
  }
}

// Active background RAM buffering jobs
const activeRamJobs = new Map();

function startRamBufferJob(cacheKey, id, maxHeight, videoOnly) {
  if (ramStreamCache.has(cacheKey)) return null;
  let job = activeRamJobs.get(cacheKey);
  if (job) return job;

  job = {
    cacheKey,
    id,
    chunks: [],
    totalBytes: 0,
    status: 'buffering',
    listeners: new Set(),
    cleanup: null,
    error: null,
    startedAt: Date.now(),
  };
  activeRamJobs.set(cacheKey, job);

  const formatStr = videoOnly
    ? `bestvideo[height<=${maxHeight}][vcodec^=avc1]/bestvideo[height<=${maxHeight}]/best`
    : `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${maxHeight}]+bestaudio/18/best[height<=${maxHeight}]/best`;

  const ytdlpArgs = [
    ...baseArgs(),
    '--buffer-size', '1M',
    '--retries', '10',
    '--fragment-retries', '10',
    '-N', '4',
    '-f', formatStr,
    '-o', '-',
    `https://www.youtube.com/watch?v=${id}`,
  ];

  const ffmpegArgs = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0',
  ];
  if (!videoOnly) {
    ffmpegArgs.push(
      '-map', '0:a:0?',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-max_muxing_queue_size', '4096'
    );
  } else {
    ffmpegArgs.push('-an');
  }
  ffmpegArgs.push(
    '-c:v', 'copy',
    '-max_muxing_queue_size', '4096',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  );

  let ytdlpProc = null;
  let ffmpegProc = null;

  try {
    ytdlpProc = spawn(YTDLP, ytdlpArgs, { windowsHide: true });
    ffmpegProc = spawn(FFMPEG, ffmpegArgs, { windowsHide: true });

    ytdlpProc.stdin?.on('error', () => {});
    ytdlpProc.stdout?.on('error', () => {});
    ytdlpProc.stderr?.on('error', () => {});
    ytdlpProc.on('error', () => {});

    ffmpegProc.stdin?.on('error', () => {});
    ffmpegProc.stdout?.on('error', () => {});
    ffmpegProc.stderr?.on('error', () => {});
    ffmpegProc.on('error', () => {});

    ytdlpProc.stdout.pipe(ffmpegProc.stdin);

    ffmpegProc.stdout.on('data', chunk => {
      job.chunks.push(chunk);
      job.totalBytes += chunk.length;
      for (const listener of job.listeners) {
        try { listener.onData(chunk); } catch (_) {}
      }
    });

    job.cleanup = () => {
      if (ytdlpProc && !ytdlpProc.killed) try { ytdlpProc.kill(); } catch (_) {}
      if (ffmpegProc && !ffmpegProc.killed) try { ffmpegProc.kill(); } catch (_) {}
    };

    ffmpegProc.on('close', code => {
      if (ytdlpProc && !ytdlpProc.killed) try { ytdlpProc.kill(); } catch (_) {}
      if (code === 0 && job.chunks.length) {
        const fullBuffer = Buffer.concat(job.chunks);
        saveRamStream(cacheKey, fullBuffer);
        job.status = 'ready';
        for (const listener of job.listeners) {
          try { listener.onEnd(); } catch (_) {}
        }
        activeRamJobs.delete(cacheKey);
      } else {
        // Fallback to youtubei.js Innertube if ytdlp failed or produced insufficient chunks
        if (job.totalBytes < 500000) {
          job.chunks = [];
          job.totalBytes = 0;
          extractWithInnertube(id, maxHeight, videoOnly).then(urls => {
            if (!urls || !urls.length) throw new Error('Extract failed');
            const fbArgs = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
            for (const u of urls) fbArgs.push('-i', u);
            fbArgs.push('-map', '0:v:0');
            if (!videoOnly) {
              if (urls.length > 1) fbArgs.push('-map', '1:a:0?');
              else fbArgs.push('-map', '0:a:0?');
              fbArgs.push(
                '-c:a', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                '-max_muxing_queue_size', '4096'
              );
            } else {
              fbArgs.push('-an');
            }
            fbArgs.push(
              '-c:v', 'copy',
              '-max_muxing_queue_size', '4096',
              '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
              '-f', 'mp4',
              'pipe:1'
            );
            const fbFfmpeg = spawn(FFMPEG, fbArgs, { windowsHide: true });
            fbFfmpeg.stdin?.on('error', () => {});
            fbFfmpeg.stdout?.on('error', () => {});
            fbFfmpeg.stderr?.on('error', () => {});
            fbFfmpeg.on('error', () => {});
            job.cleanup = () => { if (!fbFfmpeg.killed) try { fbFfmpeg.kill(); } catch (_) {} };
            fbFfmpeg.stdout.on('data', c => {
              job.chunks.push(c);
              job.totalBytes += c.length;
              for (const listener of job.listeners) {
                try { listener.onData(c); } catch (_) {}
              }
            });
            fbFfmpeg.on('close', fbCode => {
              if (fbCode === 0 && job.chunks.length) {
                const fullBuffer = Buffer.concat(job.chunks);
                saveRamStream(cacheKey, fullBuffer);
                job.status = 'ready';
                for (const listener of job.listeners) {
                  try { listener.onEnd(); } catch (_) {}
                }
              } else {
                job.status = 'error';
                job.error = 'Innertube fallback remux failed';
                for (const listener of job.listeners) {
                  try { listener.onError(job.error); } catch (_) {}
                }
              }
              activeRamJobs.delete(cacheKey);
            });
          }).catch(err => {
            job.status = 'error';
            job.error = err.message || 'Stream extraction failed';
            for (const listener of job.listeners) {
              try { listener.onError(job.error); } catch (_) {}
            }
            activeRamJobs.delete(cacheKey);
          });
        } else {
          job.status = 'error';
          job.error = 'Stream interrupted';
          for (const listener of job.listeners) {
            try { listener.onError(job.error); } catch (_) {}
          }
          activeRamJobs.delete(cacheKey);
        }
      }
    });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    for (const listener of job.listeners) {
      try { listener.onError(job.error); } catch (_) {}
    }
    activeRamJobs.delete(cacheKey);
  }

  return job;
}

// ---------- Preload into RAM API ----------
app.get('/api/preload/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const quality = String(req.query.quality || 'auto');
  const maxHeight = quality === 'auto' ? 720 : Number(quality);
  const cacheKey = `${id}:m:${quality}`;

  const cached = getCachedRamStream(cacheKey);
  if (cached) {
    return res.json({ status: 'ready', cached: true, totalBytes: cached.length });
  }

  const job = startRamBufferJob(cacheKey, id, maxHeight, false);
  return res.json({
    status: job ? job.status : 'buffering',
    cached: false,
    totalBytes: job ? job.totalBytes : 0,
  });
});

app.get('/api/preload/status/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const quality = String(req.query.quality || 'auto');
  const cacheKey = `${id}:m:${quality}`;

  const cached = getCachedRamStream(cacheKey);
  if (cached) {
    return res.json({ status: 'ready', cached: true, totalBytes: cached.length });
  }

  const job = activeRamJobs.get(cacheKey);
  if (job) {
    return res.json({ status: job.status, cached: false, totalBytes: job.totalBytes });
  }
  return res.json({ status: 'idle', cached: false, totalBytes: 0 });
});

// ---------- browser-compatible player stream ----------
app.get('/api/stream/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const videoOnly = req.query.track === 'video';
  if (req.query.track && !videoOnly) return res.status(400).json({ error: 'bad stream track' });
  const quality = String(req.query.quality || 'auto');
  if (quality !== 'auto' && (!/^\d{3,4}$/.test(quality) || Number(quality) > 4320))
    return res.status(400).json({ error: 'bad playback quality' });
  const maxHeight = quality === 'auto' ? 720 : Number(quality);
  const start = Number(req.query.start || 0);
  const duration = Number(req.query.duration || 0);
  if (!Number.isFinite(start) || start < 0 || start > 12 * 60 * 60
    || !Number.isFinite(duration) || duration < 0 || duration > 12 * 60 * 60
    || (duration && start >= duration))
    return res.status(400).json({ error: 'bad start time' });

  const cacheKey = `${id}:${videoOnly ? 'v' : 'm'}:${quality}`;

  // 1. Instant RAM cache hit: serves 100% in-memory with range seeking & zero lag
  const cachedBuffer = getCachedRamStream(cacheKey);
  if (cachedBuffer) {
    return serveStreamBuffer(req, res, cachedBuffer);
  }

  // 2. If seeking at a non-zero timestamp and not in cache, use direct section stream
  if (start > 0) {
    const formatStr = videoOnly
      ? `bestvideo[height<=${maxHeight}][vcodec^=avc1]/bestvideo[height<=${maxHeight}]/best`
      : `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${maxHeight}]+bestaudio/18/best[height<=${maxHeight}]/best`;
    const ytdlpArgs = [
      ...baseArgs(),
      '--buffer-size', '64K',
      '--retries', '10',
      '--fragment-retries', '10',
      '-f', formatStr,
      '--download-sections', `*${start}-${duration || ''}`,
      '-o', '-',
      `https://www.youtube.com/watch?v=${id}`,
    ];
    const ffmpegArgs = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-map', '0:v:0',
    ];
    if (!videoOnly) {
      ffmpegArgs.push(
        '-map', '0:a:0?',
        '-c:a', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-max_muxing_queue_size', '4096'
      );
    } else {
      ffmpegArgs.push('-an');
    }
    ffmpegArgs.push(
      '-c:v', 'copy',
      '-max_muxing_queue_size', '4096',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );
    try {
      const pYt = spawn(YTDLP, ytdlpArgs, { windowsHide: true });
      const pFf = spawn(FFMPEG, ffmpegArgs, { windowsHide: true });

      pYt.stdin?.on('error', () => {});
      pYt.stdout?.on('error', () => {});
      pYt.stderr?.on('error', () => {});
      pYt.on('error', () => {});

      pFf.stdin?.on('error', () => {});
      pFf.stdout?.on('error', () => {});
      pFf.stderr?.on('error', () => {});
      pFf.on('error', () => {});

      pYt.stdout.pipe(pFf.stdin);

      const clean = () => {
        if (!pYt.killed) try { pYt.kill(); } catch (_) {}
        if (!pFf.killed) try { pFf.kill(); } catch (_) {}
      };
      pFf.on('close', clean);
      res.on('close', clean);

      res.set({
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      pFf.stdout.pipe(res);
      return;
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // 3. Normal start=0 playback: attach to or start background RAM buffer job
  let job = activeRamJobs.get(cacheKey);
  if (!job) {
    job = startRamBufferJob(cacheKey, id, maxHeight, videoOnly);
  }

  if (!job) {
    // If just finished buffering and saved
    const readyBuffer = getCachedRamStream(cacheKey);
    if (readyBuffer) return serveStreamBuffer(req, res, readyBuffer);
    return res.status(500).json({ error: 'Failed to initialize buffer' });
  }

  if (job.status === 'error') {
    return res.status(502).json({ error: job.error || 'Playback stream failed' });
  }

  res.set({
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  // Stream existing buffered chunks immediately
  for (const chunk of job.chunks) {
    if (res.writableEnded || !res.writable) break;
    try { res.write(chunk); } catch (_) {}
  }

  // If job completed while writing
  if (job.status === 'ready' && !res.writableEnded) {
    try { return res.end(); } catch (_) {}
  }

  const listener = {
    onData: chunk => {
      if (!res.writableEnded && res.writable) {
        try { res.write(chunk); } catch (_) {}
      }
    },
    onEnd: () => {
      if (!res.writableEnded && res.writable) {
        try { res.end(); } catch (_) {}
      }
    },
    onError: () => {
      if (!res.writableEnded) {
        try { res.destroy(); } catch (_) {}
      }
    },
  };

  job.listeners.add(listener);
  res.on('close', () => {
    job.listeners.delete(listener);
  });
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
    if (!(h >= 100 && h <= 4320)) return null;
    args = [
      '-f', `bv*[height=${h}]+ba/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
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

function startDownloadAttempt(jobId, job, attempt = 1) {
  job.status = 'running';
  job.attempt = attempt;
  job.stage = attempt === 1 ? 'Starting' : `Retrying connection (${attempt}/${MAX_DOWNLOAD_ATTEMPTS})`;
  let err = '';
  let settled = false;
  const finishAttempt = (code, spawnError) => {
    if (settled) return;
    settled = true;
    if (spawnError) err = 'yt-dlp is not installed or could not be found on PATH';
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
    job.status = 'error';
    job.stage = 'Failed';
    job.error = message;
    job.completed = Date.now();
    dispatchNextQueuedJob();
  };

  const pArgs = [
    ...baseArgs(), ...DOWNLOAD_RETRY_ARGS, '--newline', '--concurrent-fragments', '4', '--windows-filenames',
  ];
  if (FFMPEG_DIR) pArgs.push('--ffmpeg-location', FFMPEG_DIR);
  pArgs.push(
    '-o', path.join(job.dir, '%(title).100s.%(ext)s'), ...job.args,
    `https://www.youtube.com/watch?v=${job.videoId}`
  );
  const p = spawn(YTDLP, pArgs);
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
