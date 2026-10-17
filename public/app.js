const $ = s => document.querySelector(s);
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

function renderVideos(results) {
  rememberHomeVideos(results);
  const firstCard = grid.children.length;
  grid.insertAdjacentHTML('beforeend', results.map((v, index) => `
    <article class="card" data-id="${v.id}" data-title="${esc(v.title)}" data-duration="${Number(v.duration) || 0}">
      <div class="thumb" data-play><img loading="${index < 6 ? 'eager' : 'lazy'}" fetchpriority="${firstCard + index < 3 ? 'high' : 'auto'}" decoding="async" src="${esc(v.thumbnail)}" alt=""><span class="dur">${fmtDur(v.duration)}</span></div>
      <div class="meta"><h3 data-play>${esc(v.title)}</h3><p>${esc(v.channel)}${fmtViews(v.views)}</p>
      <button class="dl" data-dl>${downloadButton}</button></div>
    </article>`).join(''));
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
        const { results, hasMore: more } = await api('/api/search?' + params);
        if (token !== searchToken) return;
        renderVideos(results);
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

// ---------- player ----------
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function updatePlayerControls() {
  const video = $('#playerVideo');
  const duration = activeDuration || (Number.isFinite(video.duration) ? video.duration + streamStartOffset : 0);
  const current = (video.currentTime || 0) + streamStartOffset;
  $('#currentTime').textContent = formatTime(current);
  $('#totalTime').textContent = formatTime(duration);
}

function updateQueueControls() {
  const playbackError = !$('#playerError').hidden;
  $('#prevVideo').disabled = queueIndex <= 0;
  $('#nextVideo').disabled = queueIndex >= playerQueue.length - 1;
  $('#togglePlayback').disabled = !playerReady || playbackError;
}

function updatePlaybackQualityOptions(id, qualities) {
  if (activeVideoId !== id) return;
  availablePlaybackQualities = [...new Set((qualities || [])
    .map(Number).filter(height => Number.isInteger(height) && height >= 1 && height <= 4320))]
    .sort((a, b) => b - a);
  if (playerQuality !== 'auto' && !availablePlaybackQualities.includes(Number(playerQuality)))
    playerQuality = 'auto';
  const options = [
    { value: 'auto', label: 'Auto' },
    ...availablePlaybackQualities.map(height => ({ value: String(height), label: `${height}p` })),
  ];
  $('#qualityOptions').innerHTML = options.map(option => `
    <button type="button" data-quality="${option.value}" aria-pressed="${playerQuality === option.value}"
      class="${playerQuality === option.value ? 'selected' : ''}">${option.label}</button>`).join('');
  $('#settingsQualityValue').textContent = playerQuality === 'auto' ? 'Auto' : `${playerQuality}p`;
}

function loadPlaybackQualities(id) {
  $('#qualityOptions').innerHTML = '<button type="button" disabled>Loading qualities…</button>';
  api(`/api/info?id=${encodeURIComponent(id)}`).then(info => {
    updatePlaybackQualityOptions(id, info.playbackQualities);
  }).catch(error => {
    if (activeVideoId === id) {
      $('#qualityOptions').innerHTML = `<button type="button" disabled>${esc(error.message)}</button>`;
    }
  });
}

function unmutePlayer() {
  const video = $('#playerVideo');
  video.muted = false;
  playerMuted = false;
  if (video.volume === 0) {
    video.volume = 1;
    playerVolume = 1;
    $('#volumeBar').value = '1';
  }
  $('#volumeBar').style.setProperty('--volume-level', `${video.volume * 100}%`);
  $('#unmuteOverlay').hidden = true;
  $('#muteToggle').textContent = '🔊';
  $('#muteToggle').setAttribute('aria-label', 'Mute');
  $('#muteToggle').setAttribute('title', 'Mute');
}

function switchToEmbedPlayer(id) {
  if (!id) return;
  clearTimeout(playerFallbackTimer);
  const video = $('#playerVideo');
  try {
    video.pause();
    video.removeAttribute('data-loaded-src');
    video.removeAttribute('src');
    video.load();
  } catch (_) {}
  video.hidden = true;
  hideBuffering();
  $('#playerError').hidden = true;
  $('#ramStatusBadge').textContent = '⚡ Web Player';
  const playerControls = $('.player-controls');
  if (playerControls) playerControls.hidden = true;

  let iframe = $('#playerIframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'playerIframe';
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:12px;position:absolute;top:0;left:0;z-index:10;';
    $('#playerContainer').appendChild(iframe);
  }
  iframe.hidden = false;
  iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
  playerReady = true;
  updateQueueControls();
}

function showPlayerError(message) {
  if (activeVideoId) {
    switchToEmbedPlayer(activeVideoId);
    return;
  }
  hideBuffering();
  showControls();
  const error = $('#playerError');
  error.replaceChildren(document.createTextNode(`${message} `));
  error.hidden = false;
  updateQueueControls();
}

function playPlayerMedia() {
  const requestedId = activeVideoId;
  const video = $('#playerVideo');
  video.play().catch(error => {
    if (activeVideoId !== requestedId || error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') {
      video.muted = true;
      video.play().then(() => {
        $('#unmuteOverlay').hidden = false;
      }).catch(() => {
        showPlayerError('Press Play to start the video.');
      });
      return;
    }
    showPlayerError(`Playback error: ${error.message}`);
  });
}

let ramPollTimer = null;

function updateRamBadge(status, bytes = 0) {
  const badge = $('#ramStatusBadge');
  if (!badge) return;
  badge.classList.remove('buffering', 'ready');
  if (status === 'ready') {
    badge.classList.add('ready');
    badge.textContent = '⚡ RAM: Ready (Zero Buffering)';
  } else if (status === 'buffering') {
    badge.classList.add('buffering');
    const sizeStr = bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'Buffering…';
    badge.textContent = `⚡ RAM: ${sizeStr}`;
  } else {
    badge.textContent = '⚡ RAM: Checking…';
  }
}

function pollRamUntilReady(id, quality) {
  clearTimeout(ramPollTimer);
  const check = () => {
    if (activeVideoId !== id || $('#playerModal').hidden) return;
    api(`/api/preload/status/${encodeURIComponent(id)}?quality=${encodeURIComponent(quality)}`).then(res => {
      if (activeVideoId !== id) return;
      if (res.status === 'ready' || res.cached) {
        updateRamBadge('ready');
      } else {
        updateRamBadge('buffering', res.totalBytes);
        ramPollTimer = setTimeout(check, 1000);
      }
    }).catch(() => {});
  };
  ramPollTimer = setTimeout(check, 1000);
}

function setVideoSource(id, start = 0, autoplay = true) {
  const video = $('#playerVideo');
  const params = new URLSearchParams();
  if (activeDuration) params.set('duration', String(activeDuration));
  if (start) params.set('start', String(start));
  params.set('quality', playerQuality);
  const nextSrc = resolveUrl(`/api/stream/${encodeURIComponent(id)}?${params.toString()}`);
  if (video.getAttribute('data-loaded-src') !== nextSrc) {
    video.setAttribute('data-loaded-src', nextSrc);
    video.src = nextSrc;
    video.load();
  }
  if (autoplay) playPlayerMedia();
}

let playerFallbackTimer = null;

function loadPlayerVideo(id, start = 0, autoplay = true) {
  clearTimeout(playerFallbackTimer);
  const iframe = $('#playerIframe');
  if (iframe) {
    iframe.src = '';
    iframe.hidden = true;
  }
  const video = $('#playerVideo');
  video.hidden = false;
  const playerControls = $('.player-controls');
  if (playerControls) playerControls.hidden = false;
  playerReady = false;
  streamStartOffset = start;
  clearTimeout(ramPollTimer);
  showBuffering('Preparing stream…');
  showControls();
  video.volume = playerVolume;
  video.muted = playerMuted;
  $('#volumeBar').style.setProperty('--volume-level', `${(playerMuted ? 0 : playerVolume) * 100}%`);
  updateQueueControls();
  video.pause();

  // Fast 2.5s watchdog: automatically switch to responsive embed if backend stream has delay
  playerFallbackTimer = setTimeout(() => {
    if (activeVideoId === id && !playerReady) {
      switchToEmbedPlayer(id);
    }
  }, 2500);

  if (start > 0) {
    setVideoSource(id, start, autoplay);
    return;
  }

  // Pre-buffer before launching playback
  updateRamBadge('checking');
  api(`/api/preload/${encodeURIComponent(id)}?quality=${encodeURIComponent(playerQuality)}`).then(res => {
    if (activeVideoId !== id) return;
    if (res.cached || res.status === 'ready') {
      updateRamBadge('ready');
      setVideoSource(id, 0, autoplay);
    } else {
      setVideoSource(id, 0, autoplay);
    }
  }).catch(() => {
    switchToEmbedPlayer(id);
  });
}

function onPlayerMetadata() {
  const video = $('#playerVideo');
  playerReady = video.readyState >= HTMLMediaElement.HAVE_METADATA;
  if ((!activeDuration || !Number.isFinite(video.duration)) && Number.isFinite(video.duration))
    activeDuration = video.duration + streamStartOffset;
  updateQueueControls();
  updatePlayerControls();
  if (playerReady && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) hideBuffering();
}
$('#playerVideo').addEventListener('loadedmetadata', onPlayerMetadata);
$('#playerVideo').addEventListener('durationchange', updatePlayerControls);
$('#playerVideo').addEventListener('timeupdate', () => {
  updatePlayerControls();
});
function showBuffering(text) {
  const iframe = $('#playerIframe');
  if (iframe && !iframe.hidden) return;
  clearTimeout(bufferingTimer);
  const label = $('#bufferStatusText');
  if (label && text) label.textContent = text;
  bufferingTimer = setTimeout(() => {
    const activeIframe = $('#playerIframe');
    if (activeIframe && !activeIframe.hidden) return;
    if (!$('#playerModal').hidden) $('#bufferingIndicator').hidden = false;
  }, 120);
}
function hideBuffering() {
  clearTimeout(bufferingTimer);
  bufferingTimer = null;
  $('#bufferingIndicator').hidden = true;
}
function showControls() {
  clearTimeout(controlsHideTimer);
  controlsHideTimer = null;
  $('.player').classList.remove('controls-hidden');
}
function scheduleControlsHide() {
  clearTimeout(controlsHideTimer);
  if ($('#playerVideo').paused || $('#playerModal').hidden || !$('#settingsMenu').hidden) return;
  controlsHideTimer = setTimeout(() => {
    if (!$('#playerVideo').paused && $('#settingsMenu').hidden) {
      $('.player').classList.add('controls-hidden');
    }
  }, 2600);
}
function revealControls() {
  showControls();
  if (!$('#playerVideo').paused) scheduleControlsHide();
}
const playerSurface = $('.player');
playerSurface.addEventListener('pointermove', revealControls);
playerSurface.addEventListener('pointerdown', revealControls);
playerSurface.addEventListener('pointerleave', () => {
  if (!$('#playerVideo').paused) scheduleControlsHide();
});
playerSurface.addEventListener('keydown', revealControls);
playerSurface.addEventListener('focusin', showControls);
playerSurface.addEventListener('focusout', () => {
  if (!$('#playerVideo').paused) scheduleControlsHide();
});
let stallWatchdog = null;
$('#playerVideo').addEventListener('loadstart', () => showBuffering('Connecting…'));
$('#playerVideo').addEventListener('waiting', () => {
  showBuffering('Buffering…');
});
$('#playerVideo').addEventListener('stalled', () => showBuffering('Reconnecting buffer…'));
$('#playerVideo').addEventListener('seeking', () => showBuffering('Seeking…'));
$('#playerVideo').addEventListener('canplay', hideBuffering);
$('#playerVideo').addEventListener('playing', () => {
  hideBuffering();
  clearTimeout(stallWatchdog);
  const video = $('#playerVideo');
  if (!playerMuted && video.muted) video.muted = false;
  if (playerVolume > 0 && video.volume === 0) video.volume = playerVolume;
  // Auto preload next song in queue so it's 100% in RAM when reached
  if (queueIndex < playerQueue.length - 1) {
    const next = playerQueue[queueIndex + 1];
    if (next && next.id) {
      fetch(resolveUrl(`/api/preload/${encodeURIComponent(next.id)}?quality=${encodeURIComponent(playerQuality)}`)).catch(() => {});
    }
  }
});
$('#playerVideo').addEventListener('seeked', () => {
  if ($('#playerVideo').readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) hideBuffering();
});
$('#playerVideo').addEventListener('play', () => {
  $('#togglePlayback').textContent = '❚❚';
  $('#togglePlayback').setAttribute('aria-label', 'Pause');
  showControls();
  scheduleControlsHide();
});
$('#playerVideo').addEventListener('pause', () => {
  $('#togglePlayback').textContent = '▶';
  $('#togglePlayback').setAttribute('aria-label', 'Play');
  showControls();
});
$('#playerVideo').addEventListener('ended', () => {
  if (queueIndex < playerQueue.length - 1) selectQueueVideo(queueIndex + 1);
});
$('#playerVideo').addEventListener('error', () => {
  hideBuffering();
  const mediaError = $('#playerVideo').error;
  if (!mediaError || mediaError.code === MediaError.MEDIA_ERR_ABORTED || $('#playerModal').hidden) return;
  switchToEmbedPlayer(activeVideoId);
});
$('#playerVideo').addEventListener('click', event => {
  if (event.target === $('#playerVideo')) {
    if (!$('#unmuteOverlay').hidden) unmutePlayer();
    else $('#togglePlayback').click();
  }
});
$('#unmuteOverlay').addEventListener('click', unmutePlayer);

function renderRelatedVideos() {
  const related = $('#relatedVideos');
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
  activeVideoId = video.id;
  activeDuration = video.duration || 0;
  $('#pTitle').textContent = video.title;
  $('#pDl').onclick = () => openDownload(video.id, video.title);
  $('#playerError').hidden = true;
  $('#unmuteOverlay').hidden = true;
  renderRelatedVideos();
  updateQueueControls();
  loadPlaybackQualities(video.id);
  loadPlayerVideo(video.id);
}

function openPlayer(id, title, duration = 0) {
  activeVideoId = id;
  activeDuration = duration;
  $('#playerError').hidden = true;
  $('#unmuteOverlay').hidden = true;
  $('#pTitle').textContent = title || '';
  $('#pDl').onclick = () => openDownload(id, title);
  updateQueueControls();
  loadPlaybackQualities(id);
  $('#playerModal').hidden = false;
  document.body.classList.add('player-open');
  renderRelatedVideos();
  loadPlayerVideo(id);

  if (!title) {
    api(`/api/info?id=${encodeURIComponent(id)}`).then(info => {
      if (activeVideoId !== id) return;
      if (info.title && info.title !== 'YouTube Video') $('#pTitle').textContent = info.title;
      $('#pDl').onclick = () => openDownload(id, info.title || title);
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
      iframe.hidden = true;
    }
    const video = $('#playerVideo');
    video.hidden = false;
    const playerControls = $('.player-controls');
    if (playerControls) playerControls.hidden = false;
    clearTimeout(playerFallbackTimer);
    clearTimeout(ramPollTimer);
    clearTimeout(stallWatchdog);
    hideBuffering();
    showControls();
    video.pause();
    video.removeAttribute('data-loaded-src');
    video.removeAttribute('src');
    video.load();
    $('#unmuteOverlay').hidden = true;
    playerReady = false;
  }
}
document.addEventListener('click', e => {
  if (e.target.matches('[data-close]')) closeModal(e.target.closest('.overlay'));
  else if (e.target.classList.contains('overlay')) closeModal(e.target);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.overlay:not([hidden])').forEach(closeModal); });

let hoverPreloadTimer = null;
grid.addEventListener('pointerover', e => {
  const card = e.target.closest('.card');
  if (!card || !card.dataset.id) return;
  clearTimeout(hoverPreloadTimer);
  hoverPreloadTimer = setTimeout(() => {
    fetch(`/api/preload/${encodeURIComponent(card.dataset.id)}?quality=${encodeURIComponent(playerQuality)}`).catch(() => {});
  }, 350);
});
grid.addEventListener('pointerout', () => clearTimeout(hoverPreloadTimer));

grid.addEventListener('click', e => {
  const c = e.target.closest('.card'); if (!c) return;
  if (e.target.closest('[data-dl]')) openDownload(c.dataset.id, c.dataset.title);
  else if (e.target.closest('[data-play]')) {
    playerQueue = [...grid.querySelectorAll('.card')].map(card => ({
      id: card.dataset.id, title: card.dataset.title, duration: Number(card.dataset.duration) || 0,
    }));
    queueIndex = playerQueue.findIndex(video => video.id === c.dataset.id);
    openPlayer(c.dataset.id, c.dataset.title, Number(c.dataset.duration) || 0);
  }
});

$('#togglePlayback').addEventListener('click', () => {
  const video = $('#playerVideo');
  if (!playerReady) return;
  if (video.paused) playPlayerMedia();
  else {
    video.pause();
  }
});
$('#prevVideo').addEventListener('click', () => selectQueueVideo(queueIndex - 1));
$('#nextVideo').addEventListener('click', () => selectQueueVideo(queueIndex + 1));
$('#relatedVideos').addEventListener('click', event => {
  const card = event.target.closest('[data-queue-index]');
  if (card) selectQueueVideo(Number(card.dataset.queueIndex));
});
$('#muteToggle').addEventListener('click', () => {
  const video = $('#playerVideo');
  playerMuted = !video.muted;
  video.muted = playerMuted;
  $('#muteToggle').textContent = playerMuted ? '🔇' : '🔊';
  $('#muteToggle').setAttribute('aria-label', playerMuted ? 'Unmute' : 'Mute');
  $('#muteToggle').setAttribute('title', playerMuted ? 'Unmute' : 'Mute');
});
$('#volumeBar').style.setProperty('--volume-level', `${playerVolume * 100}%`);
$('#volumeBar').addEventListener('input', event => {
  playerVolume = Number(event.target.value);
  $('#playerVideo').volume = playerVolume;
  event.target.style.setProperty('--volume-level', `${playerVolume * 100}%`);
  if (playerVolume > 0) {
    playerMuted = false;
    $('#playerVideo').muted = false;
    $('#unmuteOverlay').hidden = true;
    $('#muteToggle').textContent = '🔊';
    $('#muteToggle').setAttribute('aria-label', 'Mute');
    $('#muteToggle').setAttribute('title', 'Mute');
  }
});
$('#settingsButton').addEventListener('click', () => {
  const menu = $('#settingsMenu');
  menu.hidden = !menu.hidden;
  $('#settingsButton').setAttribute('aria-expanded', String(!menu.hidden));
  showControls();
  if (menu.hidden) scheduleControlsHide();
});
$('#settingsMenu').addEventListener('click', event => {
  const qualityOption = event.target.closest('[data-quality]');
  if (qualityOption) {
    const quality = qualityOption.dataset.quality;
    const currentTime = ($('#playerVideo').currentTime || 0) + streamStartOffset;
    const wasPlaying = !$('#playerVideo').paused;
    playerQuality = quality;
    updatePlaybackQualityOptions(activeVideoId, availablePlaybackQualities);
    loadPlayerVideo(activeVideoId, currentTime, wasPlaying);
  }
  const speedOption = event.target.closest('[data-speed]');
  if (speedOption) {
    const speed = Number(speedOption.dataset.speed);
    $('#playerVideo').playbackRate = speed;
    $('#settingsMenu').querySelectorAll('[data-speed]').forEach(button => {
      button.classList.toggle('selected', button === speedOption);
      button.setAttribute('aria-pressed', String(button === speedOption));
    });
    const speedLabel = speed === 1 ? 'Normal' : `${speed}×`;
    $('#currentSpeed').textContent = speed === 1 ? '1×' : `${speed}×`;
    $('#settingsSpeedValue').textContent = speedLabel;
    $('#settingsButton').setAttribute('aria-label', `Playback settings, speed ${speedLabel}`);
    $('#settingsButton').setAttribute('title', `Playback settings, speed ${speedLabel}`);
  }
  if (!qualityOption && !speedOption) return;
  $('#settingsMenu').hidden = true;
  $('#settingsButton').setAttribute('aria-expanded', 'false');
  scheduleControlsHide();
});
$('#fullscreenButton').addEventListener('click', async () => {
  const player = $('.player');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.requestFullscreen();
  } catch (error) {
    showPlayerError(`Could not change fullscreen: ${error.message}`);
  }
});
document.addEventListener('fullscreenchange', () => {
  const isFullscreen = document.fullscreenElement === $('.player');
  $('#fullscreenButton').innerHTML = isFullscreen
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v4a2 2 0 0 1-2 2H3m18 0h-4a2 2 0 0 1-2-2V3M3 15h4a2 2 0 0 1 2 2v4m12-6h-4a2 2 0 0 0-2 2v4"></path></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"></path></svg>';
  $('#fullscreenButton').setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
  $('#fullscreenButton').setAttribute('title', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
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

async function openDownload(id, title) {
  const body = $('#dBody'); $('#dTitle').textContent = title || 'Download';
  $('#dlModal').hidden = false; body.innerHTML = '<p>Loading available formats…</p>';

  const renderFormats = (vidFormats, audFormats, resolvedTitle) => {
    $('#dTitle').textContent = resolvedTitle;
    const optBtn = (kind, q, label, size) => `<button class="opt" data-kind="${kind}" data-q="${q}"><span>${label}</span><small>${fmtSize(size)}</small></button>`;
    body.innerHTML = `
      <div class="tabs"><button class="tab on" data-tab="video">🎬 Video (MP4)</button><button class="tab" data-tab="audio">🎵 Audio</button></div>
      <div class="opts" id="tab-video" style="display:grid">${vidFormats.map(v => optBtn('video', v.height, v.label, v.size)).join('')}</div>
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
    body.querySelectorAll('.opt').forEach(b => b.onclick = () => startJob(id, resolvedTitle, b.dataset.kind, b.dataset.q));
  };

  const defaultVideo = [
    { height: 1080, label: '1080p (HD)', size: null },
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

  try {
    const info = await api('/api/info?id=' + id);
    const resolvedTitle = (info.title && info.title !== 'YouTube Video') ? info.title : (title || 'YouTube Video');
    const vidFormats = (info.video && info.video.length) ? info.video : defaultVideo;
    const audFormats = (info.audio && info.audio.length) ? info.audio : defaultAudio;
    renderFormats(vidFormats, audFormats, resolvedTitle);
  } catch (_) {
    renderFormats(defaultVideo, defaultAudio, title || 'YouTube Video');
  }
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
    }, 1100);
  } catch (e) {
    prog.innerHTML = `<p class="err" style="margin:8px 0 0;font-size:12.5px;line-height:1.4;">${esc(e.message)}</p>`;
  }
}

// ---------- boot & server connection ----------
$('#searchForm').addEventListener('submit', e => {
  e.preventDefault(); const v = $('#q').value.trim(); const id = extractId(v);
  if (id) {
    playerQueue = [];
    queueIndex = 0;
    renderRelatedVideos();
    openPlayer(id, '');
  }
  else loadResults(true);
});
const dl = new URLSearchParams(location.search).get('dl');

// Wire Get App button
$('#getAppButton')?.addEventListener('click', () => {
  const appModal = $('#appDownloadModal');
  if (appModal) appModal.hidden = false;
});

async function boot() {
  loadResults(true);
  refreshDownloads();
  if (dl && /^[\w-]{11}$/.test(dl)) openDownload(dl, '');
}

boot();
