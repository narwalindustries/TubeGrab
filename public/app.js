const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const grid = $('#grid'), statusEl = $('#status');
const PAGE_SIZE = 24;
let activeQuery = '', currentPage = 0, loadingResults = false, hasMore = true, searchToken = 0;
let pullStartY = 0, pullDistance = 0, isPulling = false;
let feedSeed = makeFeedSeed();
let playerReady = false, activeDuration = 0, streamStartOffset = 0;
let playerQueue = [], queueIndex = 0, activeVideoId = '';
let playerVolume = 1, playerMuted = false;
let playerQuality = 'auto', availablePlaybackQualities = [];
let bufferingTimer = null, controlsHideTimer = null;
const SEEN_HOME_KEY = 'tubegrab-seen-home-videos';
const seenHomeIds = loadSeenHomeIds();
let feedExclusions = [...seenHomeIds].slice(-120);

const pullIndicator = $('#pullRefresh');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = s => { if (!s) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtViews = n => n == null ? '' : ' · ' + Intl.NumberFormat('en', { notation: 'compact' }).format(n) + ' views';
const fmtSize = b => b ? (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB') : '';
const extractId = t => (t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || [])[1];
function makeFeedSeed() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function loadSeenHomeIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(SEEN_HOME_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && /^[\w-]{11}$/.test(id)) : [];
  } catch (error) {
    console.warn('Could not read previously shown home videos:', error);
    return [];
  }
}

function rememberHomeVideos(results) {
  if (activeQuery) return;
  const uniqueIds = [...new Set([...seenHomeIds, ...results.map(video => video.id)])].slice(-240);
  seenHomeIds.splice(0, seenHomeIds.length, ...uniqueIds);
  try {
    localStorage.setItem(SEEN_HOME_KEY, JSON.stringify(uniqueIds));
  } catch (error) {
    console.warn('Could not save shown home videos:', error);
  }
}

const downloadButton = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v3h16v-3"></path></svg><span>Download</span>';

// Binary Bitwise Encryption Engine
// Decodes binary bitstreams into string values in RAM without revealing plain text in source code.
const BIT_KEY = 'TubeGrab_SecureBitMask_2026';

function decodeBinaryBits(bitstream, mask = BIT_KEY) {
  if (!bitstream || typeof bitstream !== 'string') return '';
  try {
    const cleanBits = bitstream.replace(/[^01]/g, '');
    let text = '';
    for (let i = 0; i < cleanBits.length; i += 8) {
      const byteStr = cleanBits.slice(i, i + 8);
      if (byteStr.length === 8) {
        const byteVal = parseInt(byteStr, 2);
        const charCode = byteVal ^ mask.charCodeAt((i / 8) % mask.length);
        text += String.fromCharCode(charCode);
      }
    }
    return text;
  } catch (_) {
    return '';
  }
}

function getDecryptedConfig() {
  const enc = window.__ENCRYPTED_CONFIG__ || {};
  return {
    url: enc.urlBits ? decodeBinaryBits(enc.urlBits) : '',
    key: enc.keyBits ? decodeBinaryBits(enc.keyBits) : ''
  };
}

const DEFAULT_BACKEND_URL = 'https://tubegrab-kb9u.onrender.com';

function isLocalEnvironment() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '';
}

function getApiBase() {
  if (isLocalEnvironment()) return '';
  const encConfig = getDecryptedConfig();
  if (encConfig.url) return encConfig.url.replace(/\/+$/, '');
  return window.CONFIG_BACKEND_URL || DEFAULT_BACKEND_URL;
}

function getApiKey() {
  if (isLocalEnvironment()) return '';
  const encConfig = getDecryptedConfig();
  if (encConfig.key) return encConfig.key.trim();
  return window.CONFIG_API_KEY || '';
}
try { localStorage.removeItem('tubegrab_backend_url'); } catch (_) {}

function resolveUrl(url) {
  if (!url || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) return url;
  const base = getApiBase();
  let resolved = base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;
  const key = getApiKey();
  if (key && !resolved.includes('key=')) {
    const sep = resolved.includes('?') ? '&' : '?';
    resolved += `${sep}key=${encodeURIComponent(key)}`;
  }
  return resolved;
}

function getClientId() {
  let id = localStorage.getItem('tubegrab_client_id');
  if (!id) {
    id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('tubegrab_client_id', id); } catch (_) {}
  }
  return id;
}

async function api(url, opts = {}) {
  const fullUrl = resolveUrl(url);
  const key = getApiKey();
  const options = { ...opts };
  const headers = { ...(options.headers || {}) };
  headers['x-client-id'] = getClientId();
  if (key) {
    headers['x-api-key'] = key;
  }
  options.headers = headers;
  const r = await fetch(fullUrl, options);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function renderShorts(shorts) {
  if (!shorts || !shorts.length) return '';
  return `
    <section class="shorts-shelf">
      <div class="shorts-header">
        <svg viewBox="0 0 24 24" class="shorts-icon-svg" aria-hidden="true"><path d="M17.77 10.32l-1.2-.5-1.1-.46 1.05-.59c1.78-.99 2.4-3.23 1.39-5.01-1-1.77-3.24-2.4-5.02-1.39l-7.79 4.39C3.33 7.76 2.68 9.45 3.1 11.1c.36 1.41 1.34 2.52 2.68 3l1.2.5 1.1.46-1.05.59c-1.78.99-2.4 3.23-1.39 5.01 1 1.77 3.24 2.4 5.02 1.39l7.79-4.39c1.77-1 2.42-3.24 1.42-5.01-.36-1.41-1.34-2.52-2.68-3zM10 14.65v-5.3L15 12l-5 2.65z" fill="#ff0000"/></svg>
        <h2>Shorts</h2>
      </div>
      <div class="shorts-carousel">
        ${shorts.map(s => `
          <article class="short-card" data-id="${esc(s.id)}" data-title="${esc(s.title)}" data-duration="${Number(s.duration) || 0}">
            <div class="short-thumb" data-play>
              <img loading="lazy" decoding="async" src="${esc(s.thumbnail)}" alt="">
              <span class="shorts-badge">Shorts</span>
            </div>
            <div class="short-meta">
              <h4 data-play title="${esc(s.title)}">${esc(s.title)}</h4>
              <p>${fmtViews(s.views)}</p>
              <button class="short-dl" data-dl title="Download Short">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v3h16v-3"></path></svg>
                <span>Download</span>
              </button>
            </div>
          </article>`).join('')}
      </div>
    </section>`;
}

function renderVideos(results, shorts = []) {
  rememberHomeVideos(results);
  const firstCard = grid.children.length;
  const cardHtml = (v, index, offset = 0) => `
    <article class="card" data-id="${v.id}" data-title="${esc(v.title)}" data-duration="${Number(v.duration) || 0}">
      <div class="thumb" data-play><img loading="${offset + index < 6 ? 'eager' : 'lazy'}" fetchpriority="${offset + index < 3 ? 'high' : 'auto'}" decoding="async" src="${esc(v.thumbnail)}" alt=""><span class="dur">${fmtDur(v.duration)}</span></div>
      <div class="meta"><h3 data-play>${esc(v.title)}</h3><p>${esc(v.channel)}${fmtViews(v.views)}</p>
      <button class="dl" data-dl>${downloadButton}</button></div>
    </article>`;

  if (firstCard === 0 && shorts && shorts.length > 0) {
    const splitIndex = Math.min(6, results.length);
    const topBatch = results.slice(0, splitIndex);
    const bottomBatch = results.slice(splitIndex);
    let html = topBatch.map((v, i) => cardHtml(v, i, 0)).join('');
    html += renderShorts(shorts);
    html += bottomBatch.map((v, i) => cardHtml(v, i, splitIndex)).join('');
    grid.insertAdjacentHTML('beforeend', html);
  } else {
    grid.insertAdjacentHTML('beforeend', results.map((v, i) => cardHtml(v, i, firstCard)).join(''));
  }
}

function updatePullIndicator() {
  pullIndicator.classList.toggle('visible', pullDistance > 0 || isPulling);
  pullIndicator.classList.toggle('active', pullDistance > 70);
  pullIndicator.textContent = pullDistance > 70 ? 'Release to refresh' : 'Pull to refresh';
}

function prefetchNextPage(token) {
  if (!hasMore || loadingResults) return;
  const params = new URLSearchParams({ q: activeQuery, page: currentPage, feed: feedSeed });
  if (!activeQuery && feedExclusions.length) params.set('exclude', feedExclusions.join(','));
  api('/api/search?' + params).catch(() => {
    if (token !== searchToken) return;
  });
}

async function loadResults(reset = false, refresh = false) {
  if ((!reset && loadingResults) || (!hasMore && !reset)) return;
  if (reset) {
    searchToken++;
    activeQuery = $('#q').value.trim();
    if (refresh && !activeQuery) {
      feedSeed = makeFeedSeed();
      feedExclusions = [...seenHomeIds].slice(-120);
    }
    currentPage = 0;
    hasMore = true;
    grid.innerHTML = '';
  }
  const token = searchToken;
  loadingResults = true;
  statusEl.innerHTML = `<div class="circle-spinner${currentPage > 0 ? ' circle-spinner-sm' : ''}"></div>`;
  try {
    const maxAttempts = currentPage === 0 ? 15 : 1;
    let attempt = 0;
    while (attempt < maxAttempts) {
      if (token !== searchToken) return;
      try {
        const params = new URLSearchParams({ q: activeQuery, page: currentPage, feed: feedSeed });
        if (!activeQuery && feedExclusions.length) params.set('exclude', feedExclusions.join(','));
        if (refresh) params.set('refresh', '1');
        const { results, shorts, hasMore: more } = await api('/api/search?' + params);
        if (token !== searchToken) return;
        renderVideos(results, shorts);
        hasMore = more;
        currentPage++;
        statusEl.textContent = results.length ? '' : (currentPage === 1 ? 'No videos found' : 'You have reached the end');
        return;
      } catch (e) {
        if (token !== searchToken) return;
        attempt++;
        if (attempt < maxAttempts && currentPage === 0) {
          await new Promise(r => setTimeout(r, 2500));
          continue;
        }
        statusEl.innerHTML = `<span class="err">Error: ${esc(e.message)}</span>`;
        hasMore = false;
        return;
      }
    }
  } finally {
    if (token === searchToken) {
      loadingResults = false;
      pullDistance = 0;
      isPulling = false;
      updatePullIndicator();
      prefetchNextPage(token);
    }
  }
}

const feedObserver = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) loadResults();
}, { rootMargin: '1400px 0px' });
feedObserver.observe($('#loadMore'));

const touchStart = e => {
  if (window.scrollY > 0 || loadingResults || !grid.children.length) return;
  pullStartY = e.touches[0].clientY;
  isPulling = true;
  updatePullIndicator();
};
const touchMove = e => {
  if (!isPulling || window.scrollY > 0 || loadingResults) return;
  const delta = e.touches[0].clientY - pullStartY;
  if (delta > 0) {
    pullDistance = Math.min(delta, 120);
    updatePullIndicator();
    if (pullDistance > 20) {
      window.scrollTo({ top: 0 });
    }
  }
};
const touchEnd = () => {
  if (!isPulling) return;
  if (pullDistance > 70) {
    loadResults(true, true);
  }
  pullDistance = 0;
  isPulling = false;
  updatePullIndicator();
};
window.addEventListener('touchstart', touchStart, { passive: true });
window.addEventListener('touchmove', touchMove, { passive: true });
window.addEventListener('touchend', touchEnd);
window.addEventListener('touchcancel', touchEnd);

// ---------- video player ----------
function renderRelatedVideos() {
  const related = $('#relatedVideos');
  if (!related) return;
  const upcoming = playerQueue
    .map((video, index) => ({ ...video, index }))
    .filter(video => video.id !== activeVideoId);
  related.innerHTML = upcoming.map(video => `
    <button class="related-card" type="button" data-queue-index="${video.index}">
      <span class="related-thumb"><img loading="lazy" src="https://i.ytimg.com/vi/${encodeURIComponent(video.id)}/hqdefault.jpg" alt=""></span>
      <span class="related-title">${esc(video.title)}</span>
    </button>`).join('');
}

function selectQueueVideo(index) {
  if (index < 0 || index >= playerQueue.length) return;
  queueIndex = index;
  const video = playerQueue[index];
  openPlayer(video.id, video.title, video.duration || 0);
}

function openPlayer(id, title, duration = 0) {
  activeVideoId = id;
  activeDuration = duration;
  const pDl = $('#pDl');
  if (pDl) pDl.onclick = () => openDownload(id, title);
  $('#playerModal').hidden = false;
  document.body.classList.add('player-open');
  const pQ = $('#pQ');
  if (pQ) pQ.value = $('#q')?.value || '';
  renderRelatedVideos();

  const iframe = $('#playerIframe');
  if (iframe) {
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0`;
  }

  if (!title) {
    api(`/api/info?id=${encodeURIComponent(id)}`).then(info => {
      if (activeVideoId !== id) return;
      if (pDl) pDl.onclick = () => openDownload(id, info.title || title);
      activeDuration = info.duration || activeDuration || 0;
    }).catch(() => {});
  }
}

function closeModal(m) {
  m.hidden = true;
  if (m.id === 'playerModal') {
    document.body.classList.remove('player-open');
    const iframe = $('#playerIframe');
    if (iframe) {
      iframe.src = '';
    }
  }
}

document.addEventListener('click', e => {
  if (e.target.matches('[data-close]')) closeModal(e.target.closest('.overlay'));
  else if (e.target.classList.contains('overlay')) closeModal(e.target);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay:not([hidden])').forEach(closeModal);
});

grid.addEventListener('click', e => {
  const c = e.target.closest('.card, .short-card'); if (!c) return;
  if (e.target.closest('[data-dl]')) {
    openDownload(c.dataset.id, c.dataset.title);
  } else {
    playerQueue = [...grid.querySelectorAll('.card, .short-card')].map(card => ({
      id: card.dataset.id, title: card.dataset.title, duration: Number(card.dataset.duration) || 0,
    }));
    queueIndex = playerQueue.findIndex(video => video.id === c.dataset.id);
    openPlayer(c.dataset.id, c.dataset.title, Number(c.dataset.duration) || 0);
  }
});

$('#relatedVideos')?.addEventListener('click', event => {
  const card = event.target.closest('[data-queue-index]');
  if (card) selectQueueVideo(Number(card.dataset.queueIndex));
});


// ---------- download manager ----------
const PENDING_DOWNLOADS_KEY = 'tubegrab-pending-auto-downloads';
let downloadsPollTimer = null;
let downloadPollInFlight = false;

function readPendingAutoDownloads() {
  try {
    const ids = JSON.parse(localStorage.getItem(PENDING_DOWNLOADS_KEY) || '[]');
    return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  } catch (error) {
    console.warn('Could not read pending download state:', error);
    return new Set();
  }
}

let pendingAutoDownloads = readPendingAutoDownloads();

function persistPendingAutoDownloads() {
  try {
    localStorage.setItem(PENDING_DOWNLOADS_KEY, JSON.stringify([...pendingAutoDownloads]));
  } catch (error) {
    console.warn('Could not save pending download state:', error);
  }
}

function downloadCompletedFile(job) {
  if (job.status === 'error') {
    if (pendingAutoDownloads.has(job.id)) {
      pendingAutoDownloads.delete(job.id);
      persistPendingAutoDownloads();
    }
    return;
  }
  if (job.status !== 'done' || !job.filename) return;
  if (!pendingAutoDownloads.has(job.id)) return;
  pendingAutoDownloads.delete(job.id);
  persistPendingAutoDownloads();
  const link = document.createElement('a');
  link.href = resolveUrl(`/api/jobs/${encodeURIComponent(job.id)}/file`);
  link.download = job.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function renderDownloads(jobs) {
  const activeCount = jobs.filter(job => job.status === 'running' || job.status === 'queued').length;
  $('#downloadsButton').setAttribute('aria-label',
    activeCount ? `Open downloads, ${activeCount} in progress` : 'Open downloads');

  const clearBtn = $('#clearDownloadsBtn');
  if (clearBtn) {
    const hasClearable = jobs.some(job => job.status !== 'running' && job.status !== 'queued');
    clearBtn.disabled = !hasClearable;
  }

  const fairUsageBanner = `
    <div class="fair-usage-notice">
      <span class="fair-usage-icon">🛡️</span>
      <span><strong>Fair-Usage Protection:</strong> Up to 2 downloads run simultaneously to maintain peak bandwidth. Additional downloads are safely queued and start automatically.</span>
    </div>`;

  if (!jobs.length) {
    $('#downloadsList').innerHTML = `${fairUsageBanner}<div class="downloads-empty"><p>No downloads yet.</p><span>Started downloads will continue while TubeGrab is running.</span></div>`;
    return activeCount;
  }

  const itemsHtml = jobs.map(job => {
    const audioLabels = {
      'mp3-320': 'MP3 · 320 kbps',
      'mp3-192': 'MP3 · 192 kbps',
      'mp3-128': 'MP3 · 128 kbps',
      m4a: 'M4A',
      opus: 'OPUS',
    };
    const format = job.kind === 'video'
      ? `Video · ${esc(job.quality)}p`
      : `Audio · ${esc(audioLabels[job.quality] || job.quality)}`;
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const running = job.status === 'running';
    const queued = job.status === 'queued';
    const done = job.status === 'done';
    const stateClass = running ? 'is-running' : queued ? 'is-queued' : done ? 'is-done' : 'is-error';
    const stateLabel = running ? 'In progress' : queued ? (job.queuePosition ? `In queue (#${job.queuePosition})` : 'In queue') : done ? 'Completed' : 'Failed';
    const stage = running
      ? (job.stage === 'Downloading' ? `${esc(job.stage)} · ${Math.round(progress)}%` : esc(job.stage || 'Starting'))
      : queued
        ? esc(job.stage || 'In queue · Waiting for slot')
        : done
          ? 'Ready to save'
          : esc(job.error || 'Download failed');
    const action = done
      ? `<a class="download-file" href="${resolveUrl(`/api/jobs/${encodeURIComponent(job.id)}/file`)}" download="${esc(job.filename || '')}">Download file</a>`
      : running || queued
        ? ''
        : `<button class="retry-download" type="button" data-retry="${encodeURIComponent(job.id)}">Retry</button>`;
    const removeBtn = running
      ? ''
      : `<button class="remove-download" type="button" data-remove="${encodeURIComponent(job.id)}" aria-label="Remove download" title="Remove">✕</button>`;

    return `<article class="download-item ${queued ? 'is-queued' : ''}">
      <div class="download-item-heading">
        <div><h3>${esc(job.title || 'Untitled download')}</h3><p>${format}</p></div>
        <div class="download-item-meta">
          <span class="download-state ${stateClass}">${stateLabel}</span>
          ${removeBtn}
        </div>
      </div>
      <div class="bar"><i style="width:${done ? 100 : (queued ? 100 : progress)}%"></i></div>
      <div class="download-item-footer"><span class="${job.status === 'error' ? 'err' : ''}">${stage}</span>${action}</div>
    </article>`;
  }).join('');

  $('#downloadsList').innerHTML = `${fairUsageBanner}${itemsHtml}`;
  return activeCount;
}

function scheduleDownloadsPoll(delay) {
  clearTimeout(downloadsPollTimer);
  downloadsPollTimer = setTimeout(refreshDownloads, delay);
}

async function refreshDownloads() {
  if (downloadPollInFlight) return;
  downloadPollInFlight = true;
  let activeCount = 0;
  try {
    const { jobs } = await api('/api/jobs');
    jobs.forEach(downloadCompletedFile);
    activeCount = renderDownloads(jobs);
  } catch (error) {
    console.error('Could not refresh downloads:', error);
    if (!$('#downloadsModal').hidden) {
      $('#downloadsList').innerHTML = `<p class="err">Could not load downloads: ${esc(error.message)}</p>`;
    }
  } finally {
    downloadPollInFlight = false;
  }
  if (activeCount) scheduleDownloadsPoll(1500);
  else if (!$('#downloadsModal').hidden) scheduleDownloadsPoll(5000);
}

function openDownloads() {
  $('#downloadsModal').hidden = false;
  refreshDownloads();
}

$('#downloadsButton').addEventListener('click', openDownloads);
$('#pDownloadsButton')?.addEventListener('click', openDownloads);
$('#clearDownloadsBtn')?.addEventListener('click', async () => {
  const btn = $('#clearDownloadsBtn');
  if (btn) btn.disabled = true;
  try {
    await api('/api/jobs/clear', { method: 'POST' });
    pendingAutoDownloads.clear();
    persistPendingAutoDownloads();
    refreshDownloads();
  } catch (error) {
    console.error('Could not clear download history:', error);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#downloadsList').addEventListener('click', async event => {
  const removeBtn = event.target.closest('[data-remove]');
  if (removeBtn) {
    removeBtn.disabled = true;
    try {
      await api(`/api/jobs/${removeBtn.dataset.remove}`, { method: 'DELETE' });
      pendingAutoDownloads.delete(removeBtn.dataset.remove);
      persistPendingAutoDownloads();
      refreshDownloads();
    } catch (error) {
      console.error('Could not remove download:', error);
    }
    return;
  }

  const retryButton = event.target.closest('[data-retry]');
  if (!retryButton) return;
  retryButton.disabled = true;
  retryButton.textContent = 'Retrying…';
  try {
    await api(`/api/jobs/${retryButton.dataset.retry}/retry`, { method: 'POST' });
    refreshDownloads();
  } catch (error) {
    retryButton.disabled = false;
    retryButton.textContent = 'Retry';
    console.error('Could not retry download:', error);
    retryButton.title = error.message;
  }
});

function openDownload(id, title) {
  const resolvedTitle = (title && title !== 'YouTube Video') ? title : 'YouTube Video';
  $('#dTitle').textContent = resolvedTitle;
  $('#dlModal').hidden = false;

  const defaultVideo = [
    { height: 4320, label: '4320p', size: null },
    { height: 2160, label: '2160p', size: null },
    { height: 1440, label: '1440p', size: null },
    { height: 1080, label: '1080p', size: null },
    { height: 720, label: '720p', size: null },
    { height: 480, label: '480p', size: null },
    { height: 360, label: '360p', size: null },
  ];
  const defaultAudio = [
    { q: 'mp3-320', label: 'MP3 · 320 kbps' },
    { q: 'mp3-192', label: 'MP3 · 192 kbps' },
    { q: 'mp3-128', label: 'MP3 · 128 kbps' },
    { q: 'm4a', label: 'M4A · Best (AAC)' },
    { q: 'opus', label: 'OPUS · Best quality' },
  ];

  const formatBadge = (h) => {
    if (h >= 8640) return '<span class="badge-res badge-16k">16K UHD</span>';
    if (h >= 4320) return '<span class="badge-res badge-8k">8K UHD</span>';
    if (h >= 2160) return '<span class="badge-res badge-4k">4K UHD</span>';
    if (h >= 1440) return '<span class="badge-res badge-2k">2K QHD</span>';
    if (h >= 1080) return '<span class="badge-res badge-hd">HD</span>';
    return '';
  };

  const cleanLabel = (v) => {
    const raw = String(v.label || `${v.height}p`);
    return raw.replace(/\s*\((?:16K|8K|4K|2K|HD)\)/gi, '').trim();
  };

  const renderFormats = (vidFormats, audFormats, curTitle) => {
    $('#dTitle').textContent = curTitle;
    const optBtn = (kind, q, label, size, badge = '') => `
      <button class="opt" data-kind="${kind}" data-q="${q}">
        <span>${esc(label)}${badge}</span>
        <small>${fmtSize(size)}</small>
      </button>`;
    const body = $('#dBody');
    body.innerHTML = `
      <div class="tabs"><button class="tab on" data-tab="video">🎬 Video (MP4)</button><button class="tab" data-tab="audio">🎵 Audio</button></div>
      <div class="opts" id="tab-video" style="display:grid">${vidFormats.map(v => optBtn('video', v.height, cleanLabel(v), v.size, formatBadge(v.height))).join('')}</div>
      <div class="opts" id="tab-audio" hidden style="display:none">${audFormats.map(a => optBtn('audio', a.q, a.label)).join('')}</div>
      <div id="prog"></div>`;
    body.querySelectorAll('.tab').forEach(t => t.onclick = () => {
      body.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
      const isVid = t.dataset.tab === 'video';
      const vEl = $('#tab-video'), aEl = $('#tab-audio');
      if (vEl) {
        vEl.hidden = !isVid;
        vEl.style.display = isVid ? 'grid' : 'none';
      }
      if (aEl) {
        aEl.hidden = isVid;
        aEl.style.display = isVid ? 'none' : 'grid';
      }
    });
    body.querySelectorAll('.opt').forEach(b => b.onclick = () => startJob(id, curTitle, b.dataset.kind, b.dataset.q));
  };

  // Show extraction loading spinner while analyzing real formats
  const body = $('#dBody');
  body.innerHTML = `
    <div class="extracting-state">
      <div class="circle-spinner" style="width:36px;height:36px;border-width:3px;margin:12px auto 6px;"></div>
      <p>Extracting stream formats…</p>
      <span>Analyzing video resolutions up to 8K / 4K UHD</span>
    </div>`;

  // Fetch real formats
  api('/api/info?id=' + encodeURIComponent(id)).then(info => {
    if ($('#dlModal').hidden) return;
    const t = (info.title && info.title !== 'YouTube Video') ? info.title : resolvedTitle;
    const vidFormats = (info.video && info.video.length) ? info.video : defaultVideo;
    const audFormats = (info.audio && info.audio.length) ? info.audio : defaultAudio;
    renderFormats(vidFormats, audFormats, t);
  }).catch(() => {
    if ($('#dlModal').hidden) return;
    renderFormats(defaultVideo, defaultAudio, resolvedTitle);
  });
}

async function startJob(id, title, kind, q) {
  const prog = $('#prog');
  prog.innerHTML = '<p style="color:#71dda0;margin:6px 0 0;font-weight:600;">Connecting to processing engine…</p>';
  try {
    const res = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, kind, q }),
    });
    if (res.jobId) {
      pendingAutoDownloads.add(res.jobId);
      persistPendingAutoDownloads();
    }
    refreshDownloads();
    if (res.status === 'queued') {
      prog.innerHTML = `<p style="color:#7dd3fc;margin:6px 0 0;font-size:12.5px;font-weight:600;">⏳ Queued (#${res.queuePosition || 1}) — Starts automatically as soon as an active download finishes.</p>`;
    } else {
      prog.innerHTML = '<p style="color:#71dda0;margin:6px 0 0;font-weight:600;">✓ Download started!</p>';
    }
    setTimeout(() => {
      closeModal($('#dlModal'));
      openDownloads();
    }, 900);
  } catch (e) {
    prog.innerHTML = `<p class="err" style="margin:8px 0 0;font-size:12.5px;line-height:1.4;">${esc(e.message)}</p>`;
  }
}

const handleSearchSubmit = (inputEl) => {
  const v = (inputEl?.value || '').trim();
  const id = extractId(v);
  const mainQ = $('#q');
  if (mainQ) mainQ.value = v;
  const pQ = $('#pQ');
  if (pQ) pQ.value = v;
  if (id) {
    playerQueue = [];
    queueIndex = 0;
    renderRelatedVideos();
    openPlayer(id, '');
  } else {
    closeModal($('#playerModal'));
    loadResults(true);
  }
};

$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  handleSearchSubmit($('#q'));
});

$('#pSearchForm')?.addEventListener('submit', e => {
  e.preventDefault();
  handleSearchSubmit($('#pQ'));
});
const dl = new URLSearchParams(location.search).get('dl');

// Wire Get App buttons
const openAppModal = () => {
  const appModal = $('#appDownloadModal');
  if (appModal) appModal.hidden = false;
};
$('#getAppButton')?.addEventListener('click', openAppModal);
$('#pGetAppButton')?.addEventListener('click', openAppModal);

async function boot() {
  loadResults(true);
  refreshDownloads();
  if (dl && /^[\w-]{11}$/.test(dl)) openDownload(dl, '');
}

boot();
