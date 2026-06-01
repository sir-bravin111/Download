// ── CONFIG ────────────────────────────────────────────────────────────[...]
// Updated API Base - Now pointing to the correct working endpoints
const BASE = 'https://api.example.com'; // Replace with your actual API domain

const TRENDING_QUERIES = [
  'trending music 2026',
  'top hits 2026',
  'popular songs today',
];

const MP4_QUALITIES = [
  { v: '360', l: '360p', tag: 'Low' },
  { v: '480', l: '480p', tag: 'SD' },
  { v: '720', l: '720p', tag: 'HD' },
  { v: '1080', l: '1080p', tag: 'Full HD' },
];

// ── STATE ────────────────────────────────────────────────────────────[...]
let mode              = 'video';
let currentQuery      = '';
let videoNextToken    = null;
let playlistNextToken = null;
let currentNpbId      = null;
let selectedQualities = {};
let dlInProgress      = {};

// Modal state
let modalVideoId  = null;
let modalType     = null;
let modalExpanded = false;
let modalTitle    = '';
let modalChannel  = '';
let modalThumb    = '';

// Cache for video metadata (title/channel/thumb) keyed by videoId
// FIX: Prevents crash when openPlayer is called and the card isn't in the DOM
const videoCache = {};

// ── HELPERS ───────────────────────────────────────────────────────────[...]
function dec(html) {
  const t = document.createElement('textarea');
  t.innerHTML = html;
  return t.value;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// FIX: Use event listeners on Load More buttons instead of inline onclick with
// string interpolation — apostrophes in song titles were breaking inline JS.
function setLoadMoreBtn(section, query, isPlaylist) {
  const old = section.querySelector('.load-more-wrap');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'load-more-wrap';
  const btn = document.createElement('button');
  btn.className = 'load-more-btn' + (isPlaylist ? ' purple' : '');
  btn.textContent = 'Load More';
  btn.addEventListener('click', () => doSearch(query, false));
  wrap.appendChild(btn);
  section.appendChild(wrap);
}

async function apiFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  } catch (err) {
    clearTimeout(timeout);
    console.error('API Fetch Error:', url, err);
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw err;
  }
}

function extractVideoId(input) {
  input = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  let m = input.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = input.match(/(?:v=|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

function extractPlaylistId(input) {
  const m = input.trim().match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── DOWNLOAD ───────────────────────────────────────────────────────────[...]
// FIX: Using new API endpoint structure - /api/download/:videoId/stream
function triggerDownload(videoId, type, quality, btnEl) {
  const key = videoId + type + (quality || '');
  if (dlInProgress[key]) return;
  dlInProgress[key] = true;

  const origHTML = btnEl ? btnEl.innerHTML : '';
  if (btnEl) {
    btnEl.innerHTML = '<span class="dl-spinner"></span> Starting…';
    btnEl.disabled = true;
  }

  const q = quality || (type === 'mp4' ? '720' : null);
  // Using new endpoint: /api/download/:videoId/stream
  let url = `${BASE}/download/${videoId}/stream?type=${type}&redirect=1`;
  if (q && type === 'mp4') url += `&quality=${q}`;

  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  if (btnEl) {
    setTimeout(() => {
      btnEl.innerHTML = '✓ Started!';
      btnEl.classList.add('dl-success');
      setTimeout(() => {
        btnEl.innerHTML = origHTML;
        btnEl.classList.remove('dl-success');
        btnEl.disabled = false;
        dlInProgress[key] = false;
      }, 2500);
    }, 800);
  } else {
    dlInProgress[key] = false;
  }
}

// ── MODE TOGGLE ─────────────────────────────────────────────────────────[...]
function setMode(m) {
  mode = m;
  document.getElementById('toggle-video').className =
    'toggle-btn' + (m === 'video' ? ' active-green' : '');
  document.getElementById('toggle-playlist').className =
    'toggle-btn' + (m === 'playlist' ? ' active-purple' : '');
  if (currentQuery) doSearch(currentQuery, true);
}

// ── SEARCH / LINK HANDLER ─────────────────────────────────────────────────────
function handleSearch(e) {
  e.preventDefault();
  const raw = document.getElementById('search-input').value.trim();
  if (!raw) return;

  const plId = extractPlaylistId(raw);
  if (plId) { openPlaylist(plId, 'YouTube Playlist'); return; }

  const vidId = extractVideoId(raw);
  if (vidId && (raw.includes('youtu.be') || raw.includes('youtube.com'))) {
    loadVideoById(vidId); return;
  }

  doSearch(raw, true);
}

// FIX: Disable search button during requests to prevent double-submit
function setSearchLoading(loading) {
  const btn = document.querySelector('.search-btn');
  const input = document.getElementById('search-input');
  if (btn) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Searching…' : 'Search';
  }
  if (input) input.disabled = loading;
}

async function loadVideoById(videoId) {
  showTrending(false);
  showEmptyState(false);
  closePlaylist();

  const sec = document.getElementById('results-section');
  sec.innerHTML = `<div class="center-msg"><div class="spinner"></div><p>Loading video…</p></div>`;

  try {
    // Updated endpoint: /api/videos/:id
    const data = await apiFetch(`${BASE}/videos/${videoId}`);
    const item = {
      videoId:      data.id || videoId,
      title:        dec(data.title || 'YouTube Video'),
      thumbnail:    data.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      channelTitle: data.channel || data.channelTitle || '',
    };
    videoCache[item.videoId] = item;
    sec.innerHTML = `
      <div class="section-head">
        <div class="section-icon">🔗</div><h3>Video from Link</h3>
      </div>
      <div class="grid single-card">${videoCardHTML(item)}</div>`;
  } catch (err) {
    const item = {
      videoId,
      title:        'YouTube Video',
      thumbnail:    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      channelTitle: '',
    };
    videoCache[videoId] = item;
    sec.innerHTML = `
      <div class="section-head">
        <div class="section-icon">🔗</div><h3>Video from Link</h3>
      </div>
      <div class="grid single-card">${videoCardHTML(item)}</div>`;
  }
}

async function doSearch(q, reset) {
  currentQuery = q;
  if (reset) { videoNextToken = null; playlistNextToken = null; }

  showTrending(false);
  showEmptyState(false);
  closePlaylist();

  const sec = document.getElementById('results-section');
  if (reset) {
    setSearchLoading(true);
    sec.innerHTML = `<div class="center-msg">
      <div class="spinner${mode === 'playlist' ? ' purple' : ''}"></div>
      <p>Searching...</p></div>`;
  }

  try {
    if (mode === 'video') await loadVideos(q, reset);
    else await loadPlaylists(q, reset);
  } catch (err) {
    const msg = err.message || 'Something went wrong.';
    sec.innerHTML = `<div class="center-msg">
      <div style="font-size:32px;margin-bottom:10px">⚠️</div>
      <p style="color:#e05252;margin-bottom:12px">${esc(msg)}</p>
    </div>`;
    // Add retry button using event listener, not inline onclick
    const retryBtn = document.createElement('button');
    retryBtn.className = 'load-more-btn';
    retryBtn.textContent = 'Try Again';
    retryBtn.style.marginTop = '8px';
    retryBtn.addEventListener('click', () => doSearch(q, true));
    sec.querySelector('.center-msg').appendChild(retryBtn);
  } finally {
    setSearchLoading(false);
  }
}

// ── VIDEO SEARCH ─────────────────────────────────────────────────────────[...]
// Updated to use new endpoint: /api/videos/search?q={query}
async function loadVideos(q, reset) {
  if (reset) videoNextToken = null;
  
  let url = `${BASE}/videos/search?q=${encodeURIComponent(q)}&maxResults=12`;
  if (videoNextToken) url += `&pageToken=${videoNextToken}`;

  const data = await apiFetch(url);
  const items = (data.results ?? []).map(r => ({
    videoId: r.id || r.videoId, 
    title: dec(r.title),
    thumbnail: r.thumbnail, 
    channelTitle: r.channel || r.channelTitle ?? '', 
    publishedAt: r.published ?? '',
  }));
  videoNextToken = data.nextPageToken ?? null;

  items.forEach(v => { videoCache[v.videoId] = v; });

  const sec = document.getElementById('results-section');
  if (reset) sec.innerHTML = '';

  if (reset && items.length === 0) {
    sec.innerHTML = `<div class="center-msg">
      <div style="font-size:40px;margin-bottom:10px;opacity:0.3">🔍</div>
      <p>No results found for <strong>${esc(q)}</strong></p>
    </div>`;
    return;
  }

  let grid = sec.querySelector('.grid');
  if (!grid) {
    sec.insertAdjacentHTML('beforeend', `
      <div class="section-head">
        <div class="section-icon">🎵</div><h3>Results</h3>
      </div><div class="grid"></div>`);
    grid = sec.querySelector('.grid');
  }

  items.forEach(v => grid.insertAdjacentHTML('beforeend', videoCardHTML(v)));

  if (videoNextToken) {
    setLoadMoreBtn(sec, q, false);
  } else {
    const old = sec.querySelector('.load-more-wrap');
    if (old) old.remove();
  }
}

// ── PLAYLIST SEARCH ────────────────────────────────────────────────────────[...]
// Updated endpoint will be handled when API is available
async function loadPlaylists(q, reset) {
  if (reset) playlistNextToken = null;
  
  let url = `${BASE}/playlists?q=${encodeURIComponent(q)}&maxResults=12`;
  if (playlistNextToken) url += `&pageToken=${playlistNextToken}`;

  const data = await apiFetch(url);
  const items = (data.results ?? []).map(r => ({
    playlistId: r.id || r.videoId ?? '', 
    title: dec(r.title),
    thumbnail: r.thumbnail, 
    channelTitle: r.channel || r.channelTitle ?? '', 
    itemCount: r.itemCount || r.videoCount,
  }));
  playlistNextToken = data.nextPageToken ?? null;

  const sec = document.getElementById('results-section');
  if (reset) sec.innerHTML = '';

  if (reset && items.length === 0) {
    sec.innerHTML = `<div class="center-msg">
      <div style="font-size:40px;margin-bottom:10px;opacity:0.3">📋</div>
      <p>No playlists found for <strong>${esc(q)}</strong></p>
    </div>`;
    return;
  }

  let grid = sec.querySelector('.grid');
  if (!grid) {
    sec.insertAdjacentHTML('beforeend', `
      <div class="section-head">
        <div class="section-icon purple">📋</div><h3>Playlists</h3>
      </div><div class="grid"></div>`);
    grid = sec.querySelector('.grid');
  }

  items.forEach(pl => grid.insertAdjacentHTML('beforeend', playlistCardHTML(pl)));

  if (playlistNextToken) {
    setLoadMoreBtn(sec, q, true);
  } else {
    const old = sec.querySelector('.load-more-wrap');
    if (old) old.remove();
  }
}

// ── VIDEO CARD HTML ────────────────────────────────────────────────────────[...]
function videoCardHTML(v) {
  const id = v.videoId;
  return `
    <div class="card" id="card-${id}" data-video-id="${id}">
      <div class="thumb-wrap" onclick="openPlayer('${id}','mp4')">
        <img src="${esc(v.thumbnail)}" alt="${esc(v.title)}" loading="lazy" />
        <div class="thumb-overlay"><div class="play-circle">&#9658;</div></div>
        <div class="now-badge" id="badge-${id}" style="display:none">&#9835; NOW PLAYING</div>
      </div>
      <div class="card-body">
        <div class="card-title">${esc(v.title)}</div>
        <div class="card-channel">${esc(v.channelTitle)}</div>
        <div class="action-row">
          <button class="btn btn-stream-mp3" id="smp3-${id}" onclick="openPlayer('${id}','mp3')">🎵 Stream MP3</button>
          <button class="btn btn-stream-mp4" id="smp4-${id}" onclick="openPlayer('${id}','mp4')">🎬 Stream MP4</button>
        </div>
        <div class="action-row">
          <button class="btn btn-dl-mp3" onclick="triggerDownload('${id}','mp3',null,this)">⬇ MP3</button>
          <div class="quality-wrap">
            <button class="btn btn-dl-mp4" style="width:100%" onclick="toggleQuality('${id}',event)">
              ⬇ MP4 <span id="qlabel-${id}">720p</span> ▾
            </button>
            <div class="quality-menu" id="qmenu-${id}">
              ${MP4_QUALITIES.map(q => `
                <div class="quality-item" onclick="selectAndDownload('${id}','${q.v}',event)">
                  <span>${q.l}</span><span class="quality-tag">${q.tag}</span>
                </div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

// ── PLAYLIST CARD HTML ───────────────────────────────────────────────────────[...]
// FIX: Use data-attributes instead of inline onclick string interpolation
// so playlist titles with apostrophes/quotes don't break JS
function playlistCardHTML(pl) {
  return `
    <div class="card playlist-card"
         data-playlist-id="${esc(pl.playlistId)}"
         data-playlist-title="${esc(pl.title)}"
         onclick="openPlaylistFromCard(this)">
      <div class="thumb-wrap">
        <img src="${esc(pl.thumbnail)}" alt="${esc(pl.title)}" loading="lazy" />
        <div class="thumb-overlay"><div class="play-circle purple">📋</div></div>
        ${pl.itemCount ? `<div class="count-badge">📋 ${pl.itemCount} videos</div>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${esc(pl.title)}</div>
        <div class="card-channel">${esc(pl.channelTitle)}</div>
      </div>
    </div>`;
}

function openPlaylistFromCard(el) {
  openPlaylist(el.dataset.playlistId, el.dataset.playlistTitle);
}

// ── PLAYER MODAL ─────────────────────────────────────────────────────────[...]
function openPlayer(id, type) {
  const modal = document.getElementById('player-modal');
  if (modalVideoId === id && modalType === type && modal.classList.contains('open')) {
    closePlayerModal(); return;
  }

  modalVideoId  = id;
  modalType     = type;
  modalExpanded = false;

  // FIX: Fall back to videoCache when card isn't present in the DOM.
  // Previously this crashed silently, leaving the modal with empty/stale data.
  const card   = document.getElementById(`card-${id}`);
  const cached = videoCache[id];

  modalTitle   = card?.querySelector('.card-title')?.textContent
               || cached?.title
               || 'YouTube Video';
  modalChannel = card?.querySelector('.card-channel')?.textContent
               || cached?.channelTitle
               || '';
  modalThumb   = card?.querySelector('img')?.src
               || cached?.thumbnail
               || `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

  const isAudio = type === 'mp3';

  document.getElementById('pm-title').textContent   = modalTitle;
  document.getElementById('pm-channel').textContent = modalChannel;
  document.getElementById('pm-thumb').src           = modalThumb;

  const badge = document.getElementById('pm-type-badge');
  badge.textContent = isAudio ? '🎵 Audio' : '🎬 Video';
  badge.className   = 'pm-type-badge ' + (isAudio ? 'green' : 'purple');

  const expBtn = document.getElementById('pm-expand-btn');
  expBtn.textContent = '⛶';
  expBtn.title = 'Maximize';
  modal.classList.remove('expanded');

  renderModalDownloadBtns(id);

  const thumbWrap = document.getElementById('pm-thumb-wrap');
  const videoWrap = document.getElementById('pm-video-wrap');
  const iframe    = document.getElementById('pm-iframe');

  if (isAudio) {
    thumbWrap.style.display = 'flex';
    videoWrap.style.display = 'none';
    iframe.style.height = '80px';
    thumbWrap.appendChild(iframe);
  } else {
    thumbWrap.style.display = 'none';
    videoWrap.style.display = 'flex';
    iframe.style.height = '100%';
    videoWrap.appendChild(iframe);
  }

  iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;
  modal.classList.add('open');

  updateAllCardStates(id, type);
  currentNpbId = id;

  document.getElementById('npb-iframe').src = '';
  document.getElementById('npb-thumb').src           = modalThumb;
  document.getElementById('npb-title').textContent   = modalTitle;
  document.getElementById('npb-channel').textContent = modalChannel;
  showNpbBar();
}

function renderModalDownloadBtns(id) {
  const wrap = document.getElementById('pm-download-btns');
  if (!wrap) return;
  wrap.innerHTML = `
    <button class="pm-dl-btn green" onclick="triggerDownload('${id}','mp3',null,this)">⬇ MP3</button>
    <div class="pm-dl-quality-wrap">
      <button class="pm-dl-btn purple" onclick="togglePmQuality(event)">
        ⬇ MP4 <span id="pm-qlabel">720p</span> ▾
      </button>
      <div class="pm-dl-quality-menu" id="pm-dl-qmenu">
        ${MP4_QUALITIES.map(q => `
          <div class="quality-item" onclick="pmSelectAndDownload('${id}','${q.v}',event)">
            <span>${q.l}</span><span class="quality-tag">${q.tag}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function togglePmQuality(e) {
  e.stopPropagation();
  document.getElementById('pm-dl-qmenu')?.classList.toggle('open');
}

function pmSelectAndDownload(id, q, e) {
  e.stopPropagation();
  const label = document.getElementById('pm-qlabel');
  if (label) label.textContent = q + 'p';
  document.getElementById('pm-dl-qmenu')?.classList.remove('open');
  const btn = e.target.closest('.pm-dl-quality-wrap')?.querySelector('.pm-dl-btn');
  triggerDownload(id, 'mp4', q, btn);
}

function closePlayerModal() {
  const modal = document.getElementById('player-modal');
  modal.classList.remove('open', 'expanded');
  document.getElementById('pm-iframe').src = '';
  document.getElementById('pm-menu').classList.remove('open');
  document.getElementById('pm-submenu').classList.remove('open');
  document.getElementById('pm-dl-qmenu')?.classList.remove('open');
  modalExpanded = false;

  if (modalVideoId) updateAllCardStates(modalVideoId, null);

  // FIX: Resume audio in NPB when modal is closed (not stopped).
  // currentNpbId is preserved until user clicks ✕ stop — so NPB reopen still works.
  if (currentNpbId) {
    document.getElementById('npb-iframe').src =
      `https://www.youtube.com/embed/${currentNpbId}?autoplay=1&rel=0`;
  }
}

function toggleExpand() {
  modalExpanded = !modalExpanded;
  const modal  = document.getElementById('player-modal');
  const expBtn = document.getElementById('pm-expand-btn');
  modal.classList.toggle('expanded', modalExpanded);
  expBtn.textContent = modalExpanded ? '⊡' : '⛶';
  expBtn.title       = modalExpanded ? 'Restore' : 'Maximize';
}

document.getElementById('player-modal').addEventListener('click', function(e) {
  if (e.target === this) closePlayerModal();
});

// ── 3-DOT MENU ──────────────────────────────────────────────────────────[...]
function toggleModalMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('pm-menu');
  menu.classList.toggle('open');
  if (!menu.classList.contains('open')) {
    document.getElementById('pm-submenu').classList.remove('open');
  }
}

function toggleModalQualitySubmenu(e) {
  e.stopPropagation();
  document.getElementById('pm-submenu').classList.toggle('open');
}

function modalDlMp3(e) {
  if (e) e.stopPropagation();
  if (!modalVideoId) return;
  triggerDownload(modalVideoId, 'mp3', null, e?.target);
  document.getElementById('pm-menu').classList.remove('open');
}

function modalDlMp4(q, e) {
  if (e) e.stopPropagation();
  if (!modalVideoId) return;
  triggerDownload(modalVideoId, 'mp4', q || '720', null);
  document.getElementById('pm-menu').classList.remove('open');
  document.getElementById('pm-submenu').classList.remove('open');
}

// ── CARD STATE ──────────────────────────────────────────────────────────[...]
function updateAllCardStates(activeId, type) {
  document.querySelectorAll('.card[data-video-id]').forEach(card => {
    const id       = card.dataset.videoId;
    const isActive = id === activeId && !!type;
    card.classList.toggle('playing', isActive);

    const badge = document.getElementById(`badge-${id}`);
    const s3    = document.getElementById(`smp3-${id}`);
    const s4    = document.getElementById(`smp4-${id}`);

    if (badge) badge.style.display = isActive ? 'flex' : 'none';
    if (s3) {
      s3.classList.toggle('active', isActive && type === 'mp3');
      s3.textContent = (isActive && type === 'mp3') ? '🎵 Playing' : '🎵 Stream MP3';
    }
    if (s4) {
      s4.classList.toggle('active', isActive && type === 'mp4');
      s4.textContent = (isActive && type === 'mp4') ? '🎬 Playing' : '🎬 Stream MP4';
    }
  });
}

// ── CARD DOWNLOAD QUALITY ─────────────────────────────────────────────────────
function toggleQuality(id, e) {
  e.stopPropagation();
  const menu = document.getElementById(`qmenu-${id}`);
  document.querySelectorAll('.quality-menu.open').forEach(m => {
    if (m !== menu) m.classList.remove('open');
  });

  // FIX: On mobile, quality dropdown can clip off-screen at the top.
  // Check available space and open downward if there isn't enough room above.
  if (!menu.classList.contains('open')) {
    const btnRect = e.currentTarget.getBoundingClientRect();
    const spaceAbove = btnRect.top;
    menu.classList.toggle('open-down', spaceAbove < 180);
  }

  menu.classList.toggle('open');
}

function selectAndDownload(id, q, e) {
  e.stopPropagation();
  selectedQualities[id] = q;
  const label = document.getElementById(`qlabel-${id}`);
  if (label) label.textContent = q + 'p';
  document.getElementById(`qmenu-${id}`)?.classList.remove('open');
  const card = document.getElementById(`card-${id}`);
  const btn  = card?.querySelector('.btn-dl-mp4');
  triggerDownload(id, 'mp4', q, btn);
}

// Close all menus on outside click
document.addEventListener('click', () => {
  document.querySelectorAll('.quality-menu.open, .pm-dl-quality-menu.open')
    .forEach(m => m.classList.remove('open'));
  const pmMenu = document.getElementById('pm-menu');
  const pmSub  = document.getElementById('pm-submenu');
  if (pmMenu?.classList.contains('open')) {
    pmMenu.classList.remove('open');
    pmSub?.classList.remove('open');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePlayerModal();
});

// ── NOW PLAYING BAR ────────────────────────────────────────────────────────[...]
function showNpbBar() {
  document.getElementById('now-playing-bar').classList.add('visible');
  document.body.classList.add('pb-bar');
}

function stopPlayer() {
  document.getElementById('npb-iframe').src = '';
  document.getElementById('pm-iframe').src  = '';

  const modal = document.getElementById('player-modal');
  if (modal.classList.contains('open')) {
    modal.classList.remove('open', 'expanded');
  }

  document.getElementById('now-playing-bar').classList.remove('visible');
  document.body.classList.remove('pb-bar');

  if (currentNpbId) updateAllCardStates(currentNpbId, null);

  // Only clear all state when user explicitly hits stop
  currentNpbId = null;
  modalVideoId = null;
  modalType    = null;
}

// FIX: NPB reopen was referencing modalVideoId which gets set to null
// elsewhere. Use currentNpbId as the reliable persistent reference instead.
document.getElementById('npb-reopen').addEventListener('click', () => {
  const id   = currentNpbId || modalVideoId;
  const type = modalType ?? 'mp4';
  if (id) openPlayer(id, type);
});

// ── PLAYLIST VIEWER ────────────────────────────────────────────────────────[...]
// Updated endpoint: /api/playlists/:id/videos
async function openPlaylist(id, title) {
  document.getElementById('playlist-viewer').classList.add('visible');
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('trending-section').style.display = 'none';
  document.getElementById('playlist-title').textContent = dec(title);
  document.getElementById('playlist-count').textContent = '';

  const grid = document.getElementById('playlist-grid');
  grid.innerHTML = `<div class="center-msg" style="grid-column:1/-1">
    <div class="spinner purple"></div><p>Loading playlist...</p></div>`;

  try {
    const data = await apiFetch(`${BASE}/playlists/${id}/videos?maxResults=50`);
    const items = (data.videos ?? []).map(r => ({
      videoId: r.id || r.videoId, 
      title: dec(r.title),
      thumbnail: r.thumbnail, 
      channelTitle: r.channel || r.channelTitle ?? '', 
      publishedAt: '',
    }));
    items.forEach(v => { videoCache[v.videoId] = v; });
    document.getElementById('playlist-count').textContent = `(${items.length} tracks)`;
    if (items.length === 0) {
      grid.innerHTML = `<div class="center-msg" style="grid-column:1/-1">This playlist appears to be empty.</div>`;
    } else {
      grid.innerHTML = items.map(v => videoCardHTML(v)).join('');
    }
  } catch (e) {
    grid.innerHTML = `<div class="center-msg" style="grid-column:1/-1">
      <div style="font-size:32px;margin-bottom:10px">⚠️</div>
      <p style="color:#e05252;margin-bottom:10px">Failed to load playlist.</p>
    </div>`;
    // Add retry button with event listener
    const retryBtn = document.createElement('button');
    retryBtn.className = 'load-more-btn purple';
    retryBtn.textContent = 'Try Again';
    retryBtn.addEventListener('click', () => openPlaylist(id, title));
    grid.querySelector('.center-msg').appendChild(retryBtn);
  }
}

function closePlaylist() {
  document.getElementById('playlist-viewer').classList.remove('visible');
  document.getElementById('results-section').style.display = '';
  if (!currentQuery) document.getElementById('trending-section').style.display = '';
}

// ── TRENDING ──────────────────────────────────────────────────────────[...]
function showTrending(show) {
  document.getElementById('trending-section').style.display = show ? '' : 'none';
}
function showEmptyState(show) {
  document.getElementById('empty-state').style.display = show ? '' : 'none';
}

// FIX: Added auto-retry (once) and a manual Retry button on persistent failure.
// Updated to use new trending endpoint
async function loadTrending(retryCount = 0) {
  const regionCode = 'US'; // Default region
  const category = 'music'; // Default category
  try {
    // Using new endpoint: /api/trending?regionCode={code}&category={cat}
    const data = await apiFetch(`${BASE}/trending?regionCode=${regionCode}&category=${category}&maxResults=8`);
    const items = (data.videos ?? data.results ?? []).map(r => ({
      videoId: r.id || r.videoId, 
      title: dec(r.title),
      thumbnail: r.thumbnail, 
      channelTitle: r.channel || r.channelTitle ?? '', 
      publishedAt: '',
    }));
    items.forEach(v => { videoCache[v.videoId] = v; });
    document.getElementById('trending-loading').style.display = 'none';
    const grid = document.getElementById('trending-grid');
    if (items.length) {
      grid.style.display = '';
      grid.innerHTML = items.map(v => videoCardHTML(v)).join('');
    }
  } catch (e) {
    if (retryCount < 1) {
      // Silent auto-retry after 2 seconds
      setTimeout(() => loadTrending(retryCount + 1), 2000);
    } else {
      const loadingEl = document.getElementById('trending-loading');
      loadingEl.innerHTML = '<p style="color:var(--muted);font-size:13px;margin-bottom:10px">Could not load trending music.</p>';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'load-more-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.style.cssText = 'font-size:12px;padding:8px 20px';
      retryBtn.addEventListener('click', () => {
        loadingEl.innerHTML = '<div class="spinner"></div><p>Loading trending music…</p>';
        document.getElementById('trending-grid').style.display = 'none';
        loadTrending(0);
      });
      loadingEl.appendChild(retryBtn);
    }
  }
}

// ── INIT ────────────────────────────────────────────────────────────[...]
loadTrending();
