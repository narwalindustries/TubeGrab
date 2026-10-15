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

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
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
const HOME_SEARCHES = [
  ...(DEFAULT_QUERY ? [DEFAULT_QUERY] : []),
  'official music video new song',
  'official music video pop single',
  'official music video Hindi song',
  'official music video Punjabi song',
  'official music video K-pop song',
  'official music video Latin pop song',
  'official music video rock single',
  'official music video R&B song',
  'official music video 2025 single',
  'official music video 2026 single',
  'Taylor Swift official music video',
  'The Weeknd official music video',
  'Dua Lipa official music video',
  'Billie Eilish official music video',
  'Ed Sheeran official music video',
  'Sabrina Carpenter official music video',
  'Ariana Grande official music video',
  'Bruno Mars official music video',
  'BTS official music video',
  'BLACKPINK official music video',
  'Bad Bunny official music video',
  'Shakira official music video',
  'Arijit Singh official music video',
  'Diljit Dosanjh official music video',
  'AP Dhillon official music video',
  'Shreya Ghoshal official music video',
  'A R Rahman official music video',
];
const MIX_TITLE_RE = /\b(playlist|mix(?:es)?|medley|mash[\s-]?up|non[\s-]?stop|jukebox|compilation|full album|top\s+\d+\s+songs|best songs|lofi mix|song collection)\b/i;
const TMP = path.join(os.tmpdir(), 'tubegrab');
fs.mkdirSync(TMP, { recursive: true });

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const q = isHomeFeed
    ? HOME_SEARCHES[seedNumber % HOME_SEARCHES.length]
    : requestedQuery;
  const page = Number(req.query.page || 0);
  if (!Number.isInteger(page) || page < 0 || page >= MAX_SEARCH_PAGES)
    return res.status(400).json({ error: 'bad page' });
  const end = (page + 1) * SEARCH_PAGE_SIZE;
  const excludeKey = isHomeFeed
    ? crypto.createHash('sha1').update([...excludedIds].sort().join(',')).digest('hex').slice(0, 10)
    : '';
  const cacheKey = `s:${isHomeFeed ? `home:${feedSeed}:${excludeKey}` : q}:${end}`;
  try {
    const entries = await cached(cacheKey, 5 * 60e3, async () => {
      let count = Math.min(500, end + (isHomeFeed ? 36 : 1));
      let items = [];
      while (true) {
        const d = await runJson(['--flat-playlist', '-J', `ytsearch${count}:${q}`], false);
        const rawEntries = (d.entries || []).filter(e => e && ID_RE.test(e.id));
        items = rawEntries
        .filter(e => !isHomeFeed || (
          !excludedIds.has(e.id)
          && !MIX_TITLE_RE.test(e.title || '')
          && (!e.duration || e.duration <= 15 * 60)
        ))
        .map(e => ({
        id: e.id,
        title: e.title,
        channel: e.channel || e.uploader,
        duration: e.duration,
        views: e.view_count,
        thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
        }));
        if (!isHomeFeed || items.length > end || rawEntries.length < count || count >= 500) break;
        count = Math.min(500, count + 36);
      }
      return items;
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

// ---------- RAM video stream cache with HTTP Range support ----------
const ramStreamCache = new Map();
const MAX_RAM_STREAMS = 12;
const RAM_STREAM_TTL = 60 * 60 * 1000;

function getCachedRamStream(key) {
  const item = ramStreamCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > RAM_STREAM_TTL) {
    ramStreamCache.delete(key);
    return null;
  }
  item.time = Date.now();
  return item.buffer;
}

function saveRamStream(key, buffer) {
  if (!buffer || buffer.length < 50000) return;
  if (ramStreamCache.size >= MAX_RAM_STREAMS) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [k, v] of ramStreamCache.entries()) {
      if (v.time < oldestTime) {
        oldestTime = v.time;
        oldestKey = k;
      }
    }
    if (oldestKey) ramStreamCache.delete(oldestKey);
  }
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

// ---------- download jobs ----------
const jobs = new Map();
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

function createDownloadJob({ videoId, kind, quality, args, title, dir }) {
  const jobId = crypto.randomUUID();
  const jobDir = dir || path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const job = {
    status: 'running',
    progress: 0,
    stage: 'Starting',
    dir: jobDir,
    created: Date.now(),
    title: String(title || '').slice(0, 300),
    videoId,
    kind,
    quality: String(quality),
    args,
  };
  jobs.set(jobId, job);
  startDownloadAttempt(jobId, job);
  return jobId;
}

app.post('/api/jobs', (req, res) => {
  const { id, kind, q, title } = req.body || {};
  if (!ID_RE.test(id || '')) return res.status(400).json({ error: 'Invalid video ID.' });
  const args = getDownloadArgs(kind, q);
  if (!args) return res.status(400).json({ error: 'Invalid download format.' });
  if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_JOBS)
    return res.status(429).json({ error: 'The server is busy. Try again in a moment.' });

  res.json({ jobId: createDownloadJob({ videoId: id, kind, quality: q, args, title }) });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Download not found.' });
  if (job.status !== 'error') return res.status(409).json({ error: 'Only failed downloads can be retried.' });
  if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_JOBS)
    return res.status(429).json({ error: 'The server is busy. Try again in a moment.' });
  job.status = 'running';
  job.error = undefined;
  job.progress = 0;
  job.retryIn = 0;
  job.completed = undefined;
  startDownloadAttempt(req.params.id, job);
  res.json({ jobId: req.params.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json({ status: j.status, progress: j.progress, stage: j.stage, error: j.error, filename: j.file });
});

app.get('/api/jobs', (_req, res) => {
  const results = [...jobs.entries()]
    .map(([id, job]) => ({
      id,
      title: job.title,
      kind: job.kind,
      quality: job.quality,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
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
    if (j.status !== 'running') {
      rmDir(j.dir);
      jobs.delete(id);
    }
  }
  res.json({ ok: true, count: jobs.size });
});

app.delete('/api/jobs', (_req, res) => {
  for (const [id, j] of jobs) {
    if (j.status !== 'running') {
      rmDir(j.dir);
      jobs.delete(id);
    }
  }
  res.json({ ok: true, count: jobs.size });
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  if (j.status === 'running') {
    if (j.process && !j.process.killed) {
      try { j.process.kill(); } catch (_) {}
    }
  }
  rmDir(j.dir);
  jobs.delete(req.params.id);
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

app.listen(PORT, () => console.log(`TubeGrab running → http://localhost:${PORT}`));
