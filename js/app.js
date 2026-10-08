/*
 * app.js — UI state, persistence, local playback, navigation, and event handlers.
 *
 * DSA usage:
 *   PlaylistList (DLL)  — active play order and playlist contents
 *   Stack               — history for Previous navigation
 *   Queue               — Up Next requested tracks
 *   Map                 — library, playlists, track lookup, API cache
 *   Set                 — liked track IDs, collections
 *   KMP + wildcard      — local search
 *   cardGrid (2D array) — keyboard navigation of card grids
 *   lyricSearch (BST)   — binary-search synced lyric highlight
 *
 * File/folder upload rules:
 *   - Real <input type="file"> elements, never display:none (use opacity:0 trick)
 *   - input.files (not .value), filter by MIME or extension
 *   - Duration via temporary Audio element (loadedmetadata)
 *   - URL.createObjectURL per file; revoked on remove
 *   - webkitRelativePath -> collection name
 *   - Drag-and-drop also supported
 *
 * Play rules:
 *   - local tracks  -> #local-audio  (no crossOrigin)
 *   - remote tracks -> #remote-audio (crossOrigin="anonymous")
 *   - Always: el.src = …; el.load(); el.play()
 *   - AudioContext created/resumed only inside user-gesture call path
 *   - sound.setup() called once per element via WeakMap cache (never repeated)
 *
 * Persistence: localStorage for metadata (not file handles). After reload,
 *   remote track metadata survives; local file handles do not (honest in UI).
 */
(function () {
  'use strict';

  /* ── Tiny helpers ────────────────────────────────────────────────────────── */

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* localStorage wrapper */
  const store = {
    read(k, d)  { try { return JSON.parse(localStorage.getItem('obsidian-' + k)) ?? d } catch { return d } },
    write(k, v) { localStorage.setItem('obsidian-' + k, JSON.stringify(v)) },
  };

  /* Escape user content for innerHTML; prefer textContent for simple fields */
  function safe(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /* Format seconds as m:ss */
  function fmt(n) {
    n = Number(n) || 0;
    return Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');
  }

  /* Generate a stable ID from a local file */
  function fileId(f) {
    return 'local:' + btoa(unescape(encodeURIComponent(
      f.name.toLowerCase() + '|' + f.size + '|' + f.lastModified
    ))).replace(/[^a-z0-9]/gi, '').slice(0, 32);
  }

  /* Show a toast notification (prefer textContent over innerHTML) */
  let _toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  /* ── App state ───────────────────────────────────────────────────────────── */

  const state = {
    library:          new Map(),                                          /* id -> track (local) */
    tracks:           new Map(store.read('catalog', []).map(t => [t.id, t])), /* all known tracks */
    likes:            new Set(store.read('likes', [])),
    playlists:        new Map(),
    order:            new ObsidianDS.PlaylistList(),                      /* DLL: active play order */
    queue:            new ObsidianDS.Queue(),                             /* Queue: up next */
    history:          new ObsidianDS.Stack(),                            /* Stack: play history */
    page:             'home',
    genre:            '',
    current:          null,                                              /* currently playing track */
    repeat:           0,                                                 /* 0=off 1=all 2=one */
    shuffle:          false,
    theme:            store.read('theme', null),
    mood:             store.read('mood', 'happy'),
    online:           [],
    trending:         [],
    lyrics:           [],
    lyricIndex:       -2,
    spatial:          store.read('spatial', 'off'),
    currentPlaylist:  null,
    sleepTimer:       null,
    sleepMinutes:     0,
    crossfade:        store.read('crossfade', 0),
    nospatialTracks:  new Set(),                                         /* tracks that can't spatialize */
  };

  /* ── Audio elements ──────────────────────────────────────────────────────── */

  const local  = $('#local-audio');
  const remote = $('#remote-audio');
  const sound  = new ObsidianSound(local, remote);

  local.volume = remote.volume = store.read('volume', 0.8);

  /* Listen for the custom event fired by audio.js when CORS blocks Web Audio */
  document.addEventListener('obsidian:nospatial', e => {
    if (state.current) {
      state.nospatialTracks.add(state.current.id);
      toast('Spatial Sound unavailable for this track (source CORS policy).');
    }
  });

  /* ── Persistence helpers ──────────────────────────────────────────────────── */

  function persistLikes()    { store.write('likes',    [...state.likes]) }
  function persistCatalog()  {
    /* Only persist remote track metadata (not blob URLs) */
    const items = [...state.tracks.values()]
      .filter(t => t.remote)
      .map(({ id, title, artist, art, duration, source, remote: rem, stream, genre }) =>
        ({ id, title, artist, art, duration, source, remote: rem, stream, genre })
      );
    store.write('catalog', items);
  }
  function savePlaylists()   {
    store.write('playlists', [...state.playlists.values()]
      .map(p => ({ id: p.id, name: p.name, tracks: p.list.toArray() })));
  }
  function loadPlaylists()   {
    store.read('playlists', []).forEach(p =>
      state.playlists.set(p.id, { ...p, list: new ObsidianDS.PlaylistList(p.tracks || []) })
    );
  }

  /* Resolve a track by id from any known source */
  function resolveTrack(id) {
    return state.library.get(id)
        || state.tracks.get(id)
        || state.online.find(t => t.id === id)
        || state.trending.find(t => t.id === id)
        || null;
  }

  /* ── Theme & mood ────────────────────────────────────────────────────────── */

  function setTheme() {
    const hr   = new Date().getHours();
    const auto = hr < 5 ? 'night' : hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : hr < 21 ? 'evening' : 'night';
    document.documentElement.dataset.time = state.theme || auto;
    document.documentElement.dataset.mood = state.mood;

    /* Compute --on-primary from the current --primary value to ensure contrast */
    const primaryStr = getComputedStyle(document.documentElement)
      .getPropertyValue('--primary').trim();
    const lum = cssColorLuminance(primaryStr);
    document.documentElement.style.setProperty('--on-primary', lum > 0.35 ? '#111' : '#fff');

    /* Update mood button */
    const moodLabels = { happy: '☀ Happy', focus: '◎ Focus', chill: '✦ Chill', energetic: '⚡ Energetic' };
    const btn = $('#top-mood');
    if (btn) btn.textContent = moodLabels[state.mood] || state.mood;
  }

  /* Parse CSS color (hex or rgb) -> relative luminance */
  function cssColorLuminance(str) {
    let r = 128, g = 128, b = 128;
    const hex = str.match(/^#?([0-9a-f]{3,8})$/i)?.[1];
    if (hex && hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else {
      const rgb = str.match(/\d+/g);
      if (rgb) { r = +rgb[0]; g = +rgb[1]; b = +rgb[2] }
    }
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  setTheme();
  setInterval(() => { if (!state.theme) setTheme() }, 60_000);
  loadPlaylists();

  /* ── Design data ─────────────────────────────────────────────────────────── */

  const moods  = ['happy', 'focus', 'chill', 'energetic'];
  const genres = ['Pop', 'Hip-Hop', 'Bollywood', 'Tollywood', 'Kollywood', 'Spanish', 'Rock', 'EDM', 'Tamil', 'Indie'];
  /* Curated earthy gradient pairs per genre tile */
  const colors = [
    ['#68786a','#b18158'], ['#556d7a','#b17d63'], ['#627b78','#d0b991'],
    ['#60616b','#a76e50'], ['#705e73','#a96b59'], ['#596e7c','#b89a68'],
    ['#667768','#b8a77a'], ['#4e746c','#9a9b6b'], ['#7c6068','#bd8969'],
    ['#a16c50','#66657b'],
  ];
  const genreSymbols = ['♫','♬','☾','⚡','✦','♪','♩','◈','♡','✧'];

  /* ── Artwork helpers ─────────────────────────────────────────────────────── */

  function artImg(t) {
    if (t && t.art) return `<img src="${safe(t.art)}" alt="" loading="lazy">`;
    const initials = String(t ? t.title || '' : '')
      .trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase() || '—';
    return `<span class="cover-placeholder" aria-hidden="true">${safe(initials)}</span>`;
  }

  /* ── Highlight search matches ───────────────────────────────────────────── */
  function highlight(value, q) {
    const text = String(value ?? '');
    if (!q) return safe(text);
    const parts = q.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    try {
      const re = new RegExp('(' + parts.join('.*') + ')', 'ig');
      return text.replace(re, m => `<mark>${safe(m)}</mark>`);
    } catch { return safe(text) }
  }

  /* ── Card and row renderers ──────────────────────────────────────────────── */

  function card(t, i = 0) {
    return `<article class="track-card" data-track="${safe(t.id)}" tabindex="0"
      style="--art1:${colors[i % colors.length][0]};--art2:${colors[i % colors.length][1]}">
      <button class="card-heart ${state.likes.has(t.id) ? 'liked' : ''}"
        data-like="${safe(t.id)}" aria-label="Like ${safe(t.title)}">
        ${state.likes.has(t.id) ? '♥' : '♡'}
      </button>
      <div class="track-art">
        ${artImg(t)}
        <button class="card-play" data-play="${safe(t.id)}" aria-label="Play ${safe(t.title)}">▶</button>
      </div>
      <div class="track-meta">
        <strong title="${safe(t.title)}">${safe(t.title)}</strong>
        <span title="${safe(t.artist)}">${safe(t.artist)}</span>
      </div>
    </article>`;
  }

  function row(t, i = 0, actions = true, playlistId = '', query = '') {
    const corsNote = state.nospatialTracks.has(t.id)
      ? `<span class="spatial-notice" title="Spatial Sound unavailable (CORS)">⚠ no spatial</span>` : '';
    return `<div class="list-row">
      <span class="row-index">${String(i + 1).padStart(2, '0')}</span>
      <div class="row-art">${artImg(t)}</div>
      <div class="row-copy">
        <strong>${highlight(t.title, query)}${corsNote}</strong>
        <span>${highlight(t.artist, query)}</span>
      </div>
      ${actions ? `<button class="heart-button ${state.likes.has(t.id) ? 'liked' : ''}"
        data-like="${safe(t.id)}">${state.likes.has(t.id) ? '♥' : '♡'}</button>` : ''}
      <span class="row-duration">${fmt(t.duration)}</span>
      <button class="player-icon" data-queue="${safe(t.id)}" title="Play next">＋</button>
      ${playlistId
        ? `<button class="player-icon" data-remove-track="${safe(playlistId)}|${safe(t.id)}" title="Remove">×</button>`
        : ''}
      <button class="player-icon" data-play="${safe(t.id)}" title="Play">▶</button>
      ${actions ? `<button class="player-icon" data-add-track="${safe(t.id)}" title="Add to playlist">▦</button>` : ''}
    </div>`;
  }

  function heading(kicker, title, sub = '', action = '') {
    return `<div class="page-heading">
      <div>
        <div class="eyebrow">${safe(kicker)}</div>
        <h1>${safe(title)}</h1>
        ${sub ? `<p>${safe(sub)}</p>` : ''}
      </div>
      ${action}
    </div>`;
  }

  function skeletonGrid(n = 6) {
    return `<div class="track-grid">${Array(n).fill('<div class="skeleton skeleton-card"></div>').join('')}</div>`;
  }
  function skeletonRows(n = 5) {
    return Array(n).fill('<div class="skeleton skeleton-row"></div>').join('');
  }

  function section(title, items, more = '') {
    return `<div class="section-head"><h2>${safe(title)}</h2>${more}</div>
      ${items.length
        ? `<div class="track-grid">${items.map((t, i) => card(t, i)).join('')}</div>`
        : `<p class="section-empty muted">No tracks available right now.</p>`}`;
  }

  /* ── Render engine ───────────────────────────────────────────────────────── */

  function render() {
    setTheme();
    $$('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.page === state.page));
    const c = $('#content');
    switch (state.page) {
      case 'home':      home(c);           break;
      case 'explore':   explore(c);        break;
      case 'search':    searchPage(c);     break;
      case 'library':   libraryPage(c);    break;
      case 'liked':     likedPage(c);      break;
      case 'playlists': playlistPage(c);   break;
      case 'blend':     blendPage(c);      break;
      case 'plans':     plansPage(c);      break;
      case 'settings':  settingsPage(c);   break;
      default:          home(c);
    }
    updateSidebar();
    attachCardTilt();
  }

  /* ── Pages ───────────────────────────────────────────────────────────────── */

  function home(c) {
    const hr     = new Date().getHours();
    const greet  = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : hr < 21 ? 'Good evening' : 'Good night';
    const tracks = [...state.library.values()];
    /* DSA: Stack.toArray() gives history newest-first; resolve each entry */
    const continueTracks = state.history.toArray()
      .map(x => resolveTrack(x.track && x.track.id)).filter(Boolean).slice(0, 8);
    const recentPlaylists = [...state.playlists.values()].slice(-6).reverse();

    /* Mark trending as loading if not yet fetched */
    const trendingSection = state.trending.length
      ? section('Trending now', state.trending.slice(0, 10),
          `<button data-refresh>Refresh</button>`)
      : `<div class="section-head"><h2>Trending now</h2><button data-refresh>Refresh</button></div>${skeletonGrid()}`;

    c.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-copy">
          <div class="eyebrow">OBSIDIAN · LISTENING ROOM</div>
          <h1>${safe(greet)}</h1>
          <p>Your music, arranged around you.</p>
          <div class="inline-actions">
            <button class="button" data-page="library">Add to your library</button>
            <button class="button secondary" data-page="explore">Explore music</button>
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="hero-art-disc"></div>
          <div class="hero-art-orbit"></div>
        </div>
      </section>

      <section class="recent-section">
        <div class="section-head">
          <h2>Recent playlists</h2>
          <button data-page="playlists">View all</button>
        </div>
        <div class="recent-playlist-grid">
          ${recentPlaylists.map((p, i) => `
            <button class="recent-playlist" data-playlist="${safe(p.id)}">
              <span class="recent-playlist-art"
                style="--cover-a:${colors[i % colors.length][0]};--cover-b:${colors[i % colors.length][1]}">
                <span>${safe(p.name.slice(0, 2).toUpperCase())}</span>
                <i>▶</i>
              </span>
              <span class="recent-playlist-name">${safe(p.name)}</span>
            </button>`).join('') ||
            `<button class="recent-playlist recent-create" data-create-playlist>
              <span class="recent-playlist-art"><span>＋</span></span>
              <span class="recent-playlist-name">Create a playlist</span>
            </button>`}
        </div>
      </section>

      ${store.read('onboard', true) ? `
        <div class="onboarding">
          <strong>Start with what you love</strong>
          <div class="step-list">
            <span><b>01</b> Add music</span>
            <span><b>02</b> Choose a mood</span>
            <span><b>03</b> Make a playlist</span>
          </div>
          <button class="close-button" data-dismiss="onboard" aria-label="Dismiss">×</button>
        </div>` : ''}

      <div class="section-head"><h2>Set the mood</h2></div>
      <div class="mood-row">
        ${moods.map(m => `<button class="mood-chip ${state.mood === m ? 'selected' : ''}" data-mood="${m}">
          ${{ happy: '☀ Happy', focus: '◎ Focus', chill: '✦ Chill', energetic: '⚡ Energetic' }[m]}
        </button>`).join('')}
      </div>

      <div class="section-head"><h2>Find your sound</h2></div>
      <div class="chip-row">
        ${genres.map(g => `<button class="genre-chip" data-genre="${safe(g)}">${safe(g)}</button>`).join('')}
      </div>

      ${section('Continue listening', continueTracks)}
      ${trendingSection}
      ${section('Fresh picks', tracks.slice(-10).reverse())}
      ${section('From your library', tracks.slice(0, 10))}
    `;
  }

  async function refreshOnline(genre = '') {
    try {
      $('#offline-banner').classList.add('hidden');
      const list = await ObsidianAPI.trending(genre);
      state.trending = list;
      list.forEach(t => state.tracks.set(t.id, t));
      persistCatalog();
      if (!list.length) throw new Error('empty');
      if (state.page === 'home' || state.page === 'explore') render();
    } catch (e) {
      if (!navigator.onLine) $('#offline-banner').classList.remove('hidden');
      else toast('Could not load online catalog right now.');
      if (state.page === 'home' || state.page === 'explore') render();
    }
  }

  function explore(c) {
    if (state.genre) {
      c.innerHTML = heading('Explore · Genre', state.genre + ' sounds',
        'A hand-picked stream of tracks in this genre.',
        `<button class="button secondary small" data-clear-genre>← All genres</button>`) +
        (state.trending.length
          ? section('Listen now', state.trending.slice(0, 25))
          : skeletonGrid(8));
      return;
    }
    c.innerHTML = heading('Explore', 'Find a new favorite', 'Pick a genre to open its own collection.') +
      `<div class="genre-grid">
        ${genres.map((g, i) => `
          <button class="genre-tile"
            style="--g1:${colors[i][0]};--g2:${colors[i][1]}"
            data-genre="${safe(g)}"
            data-symbol="${genreSymbols[i]}">
            ${safe(g)}
          </button>`).join('')}
      </div>
      ${state.trending.length
        ? section('Trending today', state.trending.slice(0, 10))
        : `<div class="section-head"><h2>Trending today</h2></div>${skeletonGrid()}`}`;
  }

  /* Search — local (KMP/wildcard) + online (Audius/iTunes) */
  function searchPage(c) {
    const q = $('#global-search') ? $('#global-search').value : '';
    c.innerHTML = heading('Search', 'Search your music',
      'Search locally and across free catalogs. Use * for wildcards like lo*fi.') +
      `<label class="global-search page-search-box">
        <span>⌕</span>
        <input id="page-search" type="search" value="${safe(q)}" placeholder="Track, artist, or lo*fi" autocomplete="off">
        <kbd>Enter</kbd>
      </label>
      <div class="section-head"><h2>Your library <span id="local-count"></span></h2></div>
      <div id="local-results"></div>
      <div class="section-head"><h2>Online results</h2></div>
      <div id="online-results">${q
        ? skeletonGrid(4)
        : '<p class="muted">Search to discover independent artists and free previews.</p>'
      }</div>`;

    renderLocalSearch(q);
    if (q) queueOnlineSearch(q);
  }

  function renderLocalSearch(q) {
    /* DSA: KMP or wildcard match across library Map */
    const found = [...state.library.values()].filter(t =>
      q && ObsidianDS.searchMatch(t.title + ' ' + t.artist, q)
    );
    const count = $('#local-count'), box = $('#local-results');
    if (count) count.textContent = `· ${found.length}`;
    if (box)   box.innerHTML = found.length
      ? found.map((t, i) => row(t, i, true, '', q)).join('')
      : `<p class="muted">${q ? 'No local matches yet.' : 'Add local music to search your collection.'}</p>`;
  }

  let _searchToken = 0, _searchTimer;
  function queueOnlineSearch(q) {
    clearTimeout(_searchTimer);
    ++_searchToken;
    if (!q) {
      const el = $('#online-results');
      if (el) el.innerHTML = '<p class="muted">Search to discover independent artists and free previews.</p>';
      return;
    }
    const el = $('#online-results');
    if (el) el.innerHTML = skeletonGrid(4);
    _searchTimer = setTimeout(() => onlineSearch(q), 320);
  }

  async function onlineSearch(q) {
    const token = ++_searchToken;
    try {
      const res = await ObsidianAPI.search(q.replaceAll('*', ' ').trim());
      if (token !== _searchToken) return;
      state.online = res;
      res.forEach(t => state.tracks.set(t.id, t));
      persistCatalog();
      $('#offline-banner').classList.add('hidden');
      const el = $('#online-results');
      if (el) el.innerHTML = res.length
        ? `<div class="track-grid">${res.map((t, i) => card(t, i)).join('')}</div>`
        : '<p>No online matches found.</p>';
    } catch (e) {
      if (token !== _searchToken) return;
      $('#offline-banner').classList.remove('hidden');
      const el = $('#online-results');
      if (el) el.innerHTML = '<p class="muted">Online catalog unavailable. Your local matches are still here.</p>';
    }
  }

  function libraryPage(c) {
    const list = [...state.library.values()];
    c.innerHTML = heading('Your music', 'My Music',
      `${list.length} track${list.length !== 1 ? 's' : ''} in your library. Files stay on this device.`,
      `<div class="inline-actions">
        <button class="button secondary small" id="btn-folder">＋ Add folder</button>
        <button class="button small" id="btn-files">＋ Add files</button>
      </div>`) +
      `<p class="muted" style="margin-bottom:16px">
        Tip: "Artist — Title.mp3" fills in details automatically.
        Matching .lrc files in the same folder are picked up too.
        After a page reload, re-add files to play them again.
      </p>
      <div class="drop-zone" id="drop-zone">
        ${list.length
          ? list.map((t, i) => row(t, i)).join('')
          : `<div class="empty-state">
              <div class="empty-icon">♫</div>
              <h3>Your music belongs here</h3>
              <p>Choose audio files or a music folder. Nothing uploads anywhere.</p>
              <button class="button" id="btn-files-empty">Add your first songs</button>
            </div>`}
      </div>`;
    attachDropZone();
  }

  function likedPage(c) {
    const list = [...state.likes].map(resolveTrack).filter(Boolean);
    c.innerHTML = heading('Your collection', 'Liked Songs', `${list.length} songs you love.`) +
      `<div class="inline-actions">
        <button class="button" data-play-all="liked">▶ Play all</button>
        <button class="button secondary" data-shuffle-all="liked">⤨ Shuffle</button>
      </div>
      <div style="margin-top:18px">
        ${list.length
          ? list.map((t, i) => row(t, i)).join('')
          : `<div class="empty-state">
              <div class="empty-icon">♡</div>
              <h3>Save songs for later</h3>
              <p>Tap the heart on any track and it will appear here.</p>
              <button class="button" data-page="explore">Explore music</button>
            </div>`}
      </div>`;
  }

  function playlistPage(c) {
    c.innerHTML = heading('Made for you', 'Playlists',
      'Collect tracks for every kind of day.',
      `<button class="button" data-create-playlist>＋ New playlist</button>`) +
      `<div class="inline-actions" style="margin-bottom:16px">
        <button class="button secondary small" data-export>Export playlists</button>
        <button class="button secondary small" data-import>Import JSON</button>
        <input id="import-input" type="file" accept="application/json"
          style="opacity:0;position:absolute;width:0;height:0;pointer-events:none">
      </div>
      <div class="genre-grid">
        ${[...state.playlists.values()].map((p, i) => `
          <div class="genre-tile" style="--g1:${colors[i%10][0]};--g2:${colors[i%10][1]}"
            data-playlist="${safe(p.id)}">
            ${safe(p.name)}
            <small style="display:block;font-size:11px;opacity:.7;margin-top:4px">${p.list.length} songs</small>
            <div class="playlist-actions">
              <button data-playlist-play="${safe(p.id)}" aria-label="Play playlist">▶</button>
              <button data-rename="${safe(p.id)}" aria-label="Rename">✎</button>
              <button data-delete="${safe(p.id)}" aria-label="Delete">×</button>
            </div>
          </div>`).join('') ||
          `<div class="empty-state" style="grid-column:1/-1">
            <h3>Start a collection</h3>
            <p>Make a playlist, then add songs from any track menu.</p>
          </div>`}
      </div>
      <div id="playlist-detail" style="margin-top:24px"></div>`;
  }

  function blendPage(c) {
    c.innerHTML = heading('Together sounds better', 'Blend',
      'Compare music profiles offline and build a shared playlist.') +
      `<div class="blend-cover">
        <i class="blend-circle"></i>
        <i class="blend-circle"></i>
      </div>
      <div class="empty-state">
        <h3>Bring two libraries together</h3>
        <p>Export your liked songs as a profile, then import a friend's to find your overlap.</p>
        <div class="inline-actions" style="justify-content:center;margin-top:12px">
          <button class="button" data-profile-export>Export my profile</button>
          <button class="button secondary" data-profile-import>Import a friend's</button>
          <input id="profile-input" type="file" accept="application/json"
            style="opacity:0;position:absolute;width:0;height:0;pointer-events:none">
        </div>
      </div>
      <div id="blend-results"></div>`;
  }

  function plansPage(c) {
    c.innerHTML = heading('A plan for every listener', 'Simple plans',
      'A visual demo of where Obsidian could grow.') +
      `<div class="genre-grid" style="max-width:700px">
        <article class="surface-card">
          <div class="eyebrow">FREE · YOURS TODAY</div>
          <h2 style="margin:10px 0 8px;font-size:28px">Free</h2>
          <p>Play music you own. Create playlists. Keep lyrics and Blend offline.</p>
          <ul style="margin:12px 0 16px;padding-left:20px;color:var(--muted);font-size:13px">
            <li>Local music library</li>
            <li>Unlimited playlists</li>
            <li>Offline lyrics &amp; Blend</li>
            <li>Spatial Sound &amp; EQ</li>
          </ul>
          <button class="button secondary" disabled>Your current plan</button>
        </article>
        <article class="surface-card">
          <div class="eyebrow">✦ PREMIUM · UI DEMO</div>
          <h2 style="margin:10px 0 8px;font-size:28px">Premium</h2>
          <p>A future home for optional extras. This is a visual demo only.</p>
          <ul style="margin:12px 0 16px;padding-left:20px;color:var(--muted);font-size:13px">
            <li>Everything in Free</li>
            <li>More listening themes</li>
            <li>Support the project</li>
          </ul>
          <button class="button" data-premium>Preview Premium badge</button>
        </article>
      </div>`;
  }

  function settingsPage(c) {
    const reduce = store.read('reduce3d', matchMedia('(prefers-reduced-motion: reduce)').matches);
    c.innerHTML = heading('Make it yours', 'Settings', 'Your choices are saved on this device.') +
      `<div class="surface-card">
        <!-- Theme -->
        <div class="setting-row">
          <div>
            <strong>Theme palette</strong>
            <span>Auto follows time of day</span>
          </div>
          <select id="theme-select" class="field" style="width:auto">
            <option value="auto" ${!state.theme ? 'selected' : ''}>Automatic</option>
            ${[['morning','Morning (light)'],['afternoon','Afternoon (light)'],['evening','Evening (warm)'],['night','Night (OLED)']]
              .map(([v, l]) => `<option value="${v}" ${state.theme === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <!-- Mood -->
        <div class="setting-row">
          <div>
            <strong>Mood accent</strong>
            <span>A soft color glow across your space</span>
          </div>
          <select id="mood-select" class="field" style="width:auto">
            ${moods.map(m => `<option value="${m}" ${state.mood === m ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}
          </select>
        </div>
        <!-- Spatial sound -->
        <div class="setting-row">
          <div>
            <strong>Spatial Sound</strong>
            <span>Browser audio positioning — not Dolby Atmos (a licensed format)</span>
          </div>
          <select id="spatial-select" class="field" style="width:auto">
            <option value="off"     ${state.spatial === 'off'      ? 'selected' : ''}>Off</option>
            <option value="wide"    ${state.spatial === 'wide'     ? 'selected' : ''}>Wide</option>
            <option value="surround"${state.spatial === 'surround' ? 'selected' : ''}>Surround-style</option>
            <option value="8d"      ${state.spatial === '8d'       ? 'selected' : ''}>8D (rotating)</option>
          </select>
        </div>
        <!-- Crossfade -->
        <div class="setting-row">
          <div>
            <strong>Crossfade</strong>
            <span id="crossfade-val">${state.crossfade}s between tracks</span>
          </div>
          <input id="crossfade-input" type="range" min="0" max="6" step="0.5"
            value="${state.crossfade}" style="width:110px;accent-color:var(--primary)">
        </div>
        <!-- Reduce 3D -->
        <div class="setting-row">
          <div>
            <strong>Reduce 3D motion</strong>
            <span>Simplify card tilt, vinyl spin, and carousel</span>
          </div>
          <input id="reduce-motion" type="checkbox" ${reduce ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--primary)">
        </div>
        <!-- Sleep timer -->
        <div class="setting-row">
          <div>
            <strong>Sleep timer</strong>
            <span id="sleep-status">${state.sleepTimer ? `Stops in ${state.sleepMinutes} min` : 'Off'}</span>
          </div>
          <div class="inline-actions">
            ${[15,30,45,60].map(m => `<button class="sleep-chip ${state.sleepMinutes === m && state.sleepTimer ? 'active' : ''}"
              data-sleep="${m}">${m}m</button>`).join('')}
            <button class="sleep-chip" data-sleep="0">Off</button>
          </div>
        </div>
      </div>

      <!-- Diagnostics -->
      <div class="surface-card" style="margin-top:20px">
        <div class="section-head" style="margin-top:0"><h2>Diagnostics</h2><button data-run-diag>Run check</button></div>
        <div id="diag-results">
          <p class="muted">Press "Run check" to test connectivity and audio.</p>
        </div>
      </div>`;
  }

  /* ── Sidebar playlist list ────────────────────────────────────────────────── */
  function updateSidebar() {
    $('#sidebar-playlists').innerHTML = [...state.playlists.values()].slice(0, 8)
      .map(p => `<button class="nav-item" data-playlist="${safe(p.id)}">
        <span>♫</span>${safe(p.name)}
      </button>`).join('');
  }

  /* ── Playlist detail view ─────────────────────────────────────────────────── */
  function showPlaylist(id) {
    const p   = state.playlists.get(id);
    if (!p) return;
    const d   = $('#playlist-detail');
    if (!d) return;
    d.innerHTML = `<div class="section-head">
      <h2>${safe(p.name)}</h2>
      <div class="inline-actions">
        <button class="button small" data-playlist-play="${safe(id)}">▶ Play all</button>
        <button class="button secondary small" data-add-current="${safe(id)}">＋ Add current song</button>
        <button class="button secondary small" data-shuffle-playlist="${safe(id)}">⤨ Shuffle</button>
        <button class="button secondary small" data-export-playlist="${safe(id)}">⬇ Export</button>
      </div>
    </div>
    ${p.list.toArray().map((t, i) => row(t, i, true, id)).join('') ||
      '<p class="muted">Add songs from your library using the playlist button.</p>'}`;
  }

  /* ── Playback engine ─────────────────────────────────────────────────────── */

  function play(t, order, fromHistory = false) {
    if (!t) return;
    /* Always resolve to most complete track object */
    t = resolveTrack(t.id) || t;
    if (!t.remote && !t.url) {
      toast('File not available. Re-add it from your device.');
      return;
    }
    if (t.remote && !t.stream) {
      toast('No stream URL for this track.');
      return;
    }

    /* Push current to history before switching (DSA: Stack push) */
    if (!fromHistory && state.current && state.current.id !== t.id) {
      state.history.push({ track: state.current, at: Date.now() });
    }

    /* Reset lyrics index when changing tracks */
    if (state.current?.id !== t.id) {
      state.lyrics   = [];
      state.lyricIndex = -2;
      /* Auto fetch lyrics in background */
      if (!store.read('lyrics:' + t.id, '')) {
        ObsidianAPI.fetchLyrics(t.artist, t.title).then(txt => {
          if (txt && state.current?.id === t.id) {
            store.write('lyrics:' + t.id, txt);
            state.lyrics = ObsidianLyrics.parse(txt);
          }
        });
      }
    }

    state.current = t;

    /* DSA: update PlaylistList current pointer */
    if (order) {
      state.order = new ObsidianDS.PlaylistList(order);
      state.order.setCurrent(t.id);
    } else if (t.remote) {
      /* For remote tracks, create an order from whichever list they came from */
      const sourceList = state.online.some(x => x.id === t.id) ? state.online
                       : state.trending.some(x => x.id === t.id) ? state.trending
                       : state.online;
      state.order = new ObsidianDS.PlaylistList(sourceList);
      state.order.setCurrent(t.id);
    } else {
      state.order.setCurrent(t.id);
    }

    /* Choose correct audio element */
    const el    = t.remote ? remote : local;
    const other = t.remote ? local  : remote;

    /* Pause the other element */
    if (!other.paused) other.pause();

    /* Reset crossOrigin: anonymous for remote, none for local */
    if (t.remote) {
      if (!state.nospatialTracks.has(t.id)) {
        el.crossOrigin = 'anonymous';
      } else {
        el.removeAttribute('crossorigin');
      }
    } else {
      el.removeAttribute('crossorigin');
    }

    /* BUG FIX B6: always call load() before play() */
    el.src = t.remote ? t.stream : t.url;
    el.load();

    const playPromise = el.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => { $('#play-button').textContent = 'Ⅱ' })
        .catch(err => {
          /* Friendly error — never a silent failure */
          console.warn('[Obsidian] play() rejected:', err.message, 'track:', t.id);
          $('#play-button').textContent = '▶';
          toast('This audio could not start. Try another track.');
        });
    }

    /* Spatial — BUG FIX B7: setup() is WeakMap-cached, so only called once per element */
    if (state.spatial !== 'off' && !state.nospatialTracks.has(t.id)) {
      sound.mode = state.spatial;
      sound.apply(el).then(ok => {
        if (!ok && state.spatial !== 'off') {
          toast('Spatial Sound unavailable for this track (CORS).');
        }
      });
    }

    /* Media Session API (lock-screen controls) */
    updateMediaSession(t);

    /* Player bar */
    updatePlayer();

    /* Vinyl in now-playing view */
    const vinyl = $('.now-vinyl');
    if (vinyl) vinyl.style.setProperty('--vinyl-state', 'running');

    /* Store last track for persistence */
    store.write('last-track', { id: t.id });
  }

  function currentEl() { return state.current?.remote ? remote : local }

  function updatePlayer() {
    const t = state.current;
    if (!t) return;
    /* Use textContent where possible (XSS safe, no HTML) */
    $('#player-title').textContent  = t.title;
    $('#player-artist').textContent = t.artist;
    $('#player-art').innerHTML      = artImg(t);
    const liked = state.likes.has(t.id);
    $('#like-current').textContent  = liked ? '♥' : '♡';
    $('#like-current').classList.toggle('liked', liked);
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  t.title,
      artist: t.artist,
      album:  t.source === 'itunes' ? 'iTunes preview' : t.source || 'Obsidian',
      artwork: t.art ? [{ src: t.art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play',         () => currentEl().play());
    navigator.mediaSession.setActionHandler('pause',        () => currentEl().pause());
    navigator.mediaSession.setActionHandler('nexttrack',    () => next());
    navigator.mediaSession.setActionHandler('previoustrack',() => previous());
  }

  function next() {
    /* DSA: Queue.dequeue() first, then DLL.step(1) */
    const queued = state.queue.dequeue();
    if (queued) { play(queued); return }

    if (state.shuffle) {
      const all = [...state.library.values(), ...state.online, ...state.trending];
      if (all.length) { play(all[Math.floor(Math.random() * all.length)]); return }
    }

    const n = state.order.step(1);
    if (n) play(n.value);
    else if (state.current) play(state.current);
  }

  function previous() {
    /* DSA: Stack.pop() for history, fallback to DLL.step(-1) */
    const h = state.history.pop();
    if (h) { play(h.track, null, true); return }
    const n = state.order.step(-1);
    if (n) play(n.value);
  }

  function like(id) {
    if (state.likes.has(id)) state.likes.delete(id);
    else                      state.likes.add(id);
    persistLikes();
    render();
    updatePlayer();
  }

  function setOrderPlay(list, index = 0) {
    if (!list.length) return;
    list = list.map(t => resolveTrack(t.id) || t).filter(Boolean);
    /* DSA: build a fresh PlaylistList from the given array */
    state.order = new ObsidianDS.PlaylistList(list);
    play(list[index], list);
  }

  /* ── Local file import ───────────────────────────────────────────────────── */

  /**
   * Read duration of a local audio file via a temporary Audio element.
   * Returns a Promise<number> (seconds).
   */
  function readDuration(url) {
    return new Promise(resolve => {
      const tmp = new Audio();
      tmp.addEventListener('loadedmetadata', () => resolve(tmp.duration || 0), { once: true });
      tmp.addEventListener('error', () => resolve(0), { once: true });
      tmp.src = url;
      setTimeout(() => resolve(0), 4000); /* fallback */
    });
  }

  async function addFiles(files) {
    const all   = [...files];
    const audio = all.filter(f =>
      f.type.startsWith('audio/') ||
      f.type.startsWith('video/') ||
      /\.(mp3|m4a|wav|ogg|flac|aac|opus|weba|mp4|webm|mkv|wma)$/i.test(f.name)
    );
    const lrcFiles = all.filter(f => /\.lrc$/i.test(f.name));
    const imgFiles = all.filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(f.name));

    if (!audio.length) { toast('No audio files found.'); return; }

    /* Parse metadata from each file */
    for (const f of audio) {
      const clean  = f.name.replace(/\.[^.]+$/, '');
      const match  = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      const parent = f.webkitRelativePath?.split('/').slice(-2, -1)[0] || '';
      const url    = URL.createObjectURL(f);
      const dur    = await readDuration(url); /* BUG FIX B10 */
      const id     = fileId(f);

      const t = {
        id,
        title:      match ? match[2] : clean,
        artist:     match ? match[1] : 'Local file',
        duration:   dur,
        url,
        file:       f,
        collection: parent && !['music', ''].includes(parent.toLowerCase()) ? parent : '',
        remote:     false,
      };
      state.library.set(t.id, t);
      state.tracks.set(t.id, t);

      /* Register as collection (DSA: Set for unique names) */
      if (t.collection) {
        const cols = new Set(store.read('collections', []));
        cols.add(t.collection);
        store.write('collections', [...cols]);
      }

      /* Add to play order DLL */
      state.order.add(t);
    }

    /* Match sidecar .lrc files by normalised base filename */
    for (const l of lrcFiles) {
      const base = l.name.replace(/\.lrc$/i, '').toLowerCase();
      const match = [...state.library.values()].find(x =>
        x.file?.name.replace(/\.[^.]+$/, '').toLowerCase() === base
      );
      if (match) {
        const r = new FileReader();
        r.onload = () => store.write('lyrics:' + match.id, r.result);
        r.readAsText(l);
      }
    }

    /* Match sidecar image files by normalised base filename or cover/folder name */
    for (const img of imgFiles) {
      const base = img.name.replace(/\.[^.]+$/, '').toLowerCase();
      const match = [...state.library.values()].find(x =>
        x.file?.name.replace(/\.[^.]+$/, '').toLowerCase() === base
      );
      if (match) {
        match.art = URL.createObjectURL(img);
      } else if (base === 'cover' || base === 'folder') {
        const parent = img.webkitRelativePath?.split('/').slice(-2, -1)[0] || '';
        if (parent) {
          [...state.library.values()].forEach(x => {
            if (x.collection === parent && !x.art) x.art = URL.createObjectURL(img);
          });
        }
      }
    }

    toast(`Added ${audio.length} song${audio.length !== 1 ? 's' : ''} to your library.`);
    render();
  }

  /* ── Drag and drop ────────────────────────────────────────────────────────── */
  function attachDropZone() {
    const zone = $('#drop-zone');
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging') });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragging');
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  /* File input elements — rendered once here to avoid stale refs */
  const fileInput   = document.createElement('input');
  fileInput.type    = 'file';
  fileInput.id      = 'file-input';
  fileInput.multiple = true;
  fileInput.accept  = 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.mp4,.webm,.lrc,.jpg,.jpeg,.png,.webp';
  fileInput.style.cssText = 'opacity:0;position:absolute;width:0;height:0;pointer-events:none';

  const folderInput = document.createElement('input');
  folderInput.type  = 'file';
  folderInput.id    = 'folder-input';
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.setAttribute('directory', '');
  folderInput.multiple = true;
  folderInput.style.cssText = 'opacity:0;position:absolute;width:0;height:0;pointer-events:none';

  document.body.appendChild(fileInput);
  document.body.appendChild(folderInput);

  fileInput.addEventListener('change',   () => { if (fileInput.files.length)   addFiles(fileInput.files);   fileInput.value   = '' });
  folderInput.addEventListener('change', () => { if (folderInput.files.length) addFiles(folderInput.files); folderInput.value = '' });

  /* ── Drawer (Up Next + history) ───────────────────────────────────────────── */
  function openDrawer() {
    const d = $('#drawer');
    d.innerHTML = `<div class="drawer-head">
      <h2>Your listening</h2>
      <button class="close-button" data-close-drawer>×</button>
    </div>
    <div class="drawer-section">
      <h3>Up Next · ${state.queue.items.length}</h3>
      ${state.queue.toArray().map((t, i) => row(t, i, false)).join('') ||
        '<p class="muted">Your queue is clear. Add songs with "Play next".</p>'}
    </div>
    <div class="drawer-section">
      <h3>Recently played</h3>
      ${state.history.toArray().slice(0, 20).map(x => `
        <div class="recent-card" data-play="${safe(x.track.id)}">
          <div class="row-art">${artImg(x.track)}</div>
          <div class="row-copy">
            <strong>${safe(x.track.title)}</strong>
            <span>${safe(x.track.artist)}</span>
          </div>
        </div>`).join('') ||
        '<p class="muted">The songs you play will show up here.</p>'}
    </div>`;
    d.classList.add('open');
    $('#drawer-scrim').classList.add('open');
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer-scrim').classList.remove('open');
  }

  /* ── Modal helper ─────────────────────────────────────────────────────────── */
  function modal(title, body) {
    $('#modal-root').innerHTML = `<div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>${safe(title)}</h2>
          <button class="close-button" data-modal-close>×</button>
        </div>
        ${body}
      </div>
    </div>`;
  }

  /* ── Now Playing full-screen view ─────────────────────────────────────────── */
  function openNowPlaying() {
    if (!state.current) { toast('Nothing is playing.'); return }
    const t = state.current;
    const paused = currentEl().paused;
    $('#modal-root').innerHTML = `<div class="now-playing-view" id="now-playing-view">
      <canvas id="now-visualizer" class="now-visualizer" aria-hidden="true"></canvas>
      <button class="now-close" data-modal-close aria-label="Close">×</button>
      <div class="vinyl-wrap">
        <div class="now-vinyl" style="--vinyl-state:${paused ? 'paused' : 'running'}"></div>
      </div>
      <div class="now-title">${safe(t.title)}</div>
      <div class="now-artist">${safe(t.artist)}</div>
      <div style="margin-top:20px;display:flex;gap:12px;justify-content:center">
        <button class="button secondary" id="now-prev">⏮</button>
        <button class="button" id="now-play">${paused ? '▶' : 'Ⅱ'}</button>
        <button class="button secondary" id="now-next">⏭</button>
      </div>
    </div>`;
    /* Sync vinyl pause/play state with actual audio */
    const synVinyl = () => {
      const v = $('.now-vinyl');
      if (v) v.style.setProperty('--vinyl-state', currentEl().paused ? 'paused' : 'running');
      const pb = $('#now-play');
      if (pb) pb.textContent = currentEl().paused ? '▶' : 'Ⅱ';
    };
    currentEl().addEventListener('play',  synVinyl);
    currentEl().addEventListener('pause', synVinyl);
    $('#now-prev').onclick = previous;
    $('#now-next').onclick = next;
    $('#now-play').onclick = () => { currentEl().paused ? currentEl().play() : currentEl().pause() };
  }

  /* ── Lyrics ────────────────────────────────────────────────────────────────── */
  function openLyrics() {
    if (!state.current) { toast('Choose a song to see its lyrics.'); return }
    const saved = store.read('lyrics:' + state.current.id, '');
    if (saved) {
      const lines = ObsidianLyrics.parse(saved);
      const display = lines.length
        ? lines
        : String(saved).split(/\r?\n/).filter(Boolean).map(text => ({ time: null, text }));
      state.lyrics    = display;
      state.lyricIndex = -2;
      lyricsModal(display);
      return;
    }
    
    lyricsModal([{time: null, text: 'Searching for lyrics...'}]);
    
    const tryOnline = () => {
      ObsidianAPI.fetchLyrics(state.current.artist, state.current.title).then(txt => {
        if (txt) {
          store.write('lyrics:' + state.current.id, txt);
          state.lyrics = ObsidianLyrics.parse(txt);
          lyricsModal(state.lyrics);
        } else {
          lyricsModal([]);
        }
      });
    };

    /* BUG FIX B16: guard against online tracks with no file handle */
    if (state.current.file) {
      ObsidianLyrics.embedded(state.current.file).then(text => {
        if (text) {
          const lines = ObsidianLyrics.parse(text);
          state.lyrics    = lines;
          state.lyricIndex = -2;
          lyricsModal(lines);
        } else {
          tryOnline();
        }
      });
    } else {
      tryOnline();
    }
  }

  function lyricsModal(lines) {
    modal('Lyrics', `
      ${lines.length
        ? `<div id="lyrics-lines" class="lyrics-lines">
            ${lines.map((l, i) => `<div class="lyric-line" data-lyric="${i}">${safe(l.text)}</div>`).join('')}
          </div>`
        : `<div class="empty-state">
            <h3>No lyrics yet</h3>
            <p>Add an .lrc sidecar file, paste lyrics, or check the embedded ID3 tag.</p>
          </div>`}
      <div class="modal-actions">
        <button class="button secondary" data-paste-lyrics>${lines.length ? 'Edit lyrics' : 'Add lyrics'}</button>
      </div>`);
  }

  function pasteLyrics() {
    const s = store.read('lyrics:' + state.current.id, '');
    modal('Add / Edit lyrics', `
      <p class="muted">Paste plain text or LRC timestamps like [00:12.40] lyric line.</p>
      <textarea id="lyrics-input" class="field" style="width:100%;min-height:160px">${safe(s)}</textarea>
      <div class="modal-actions">
        <button class="button secondary" data-modal-close>Cancel</button>
        <button class="button" data-save-lyrics>Save lyrics</button>
      </div>`);
  }

  /* ── Blend logic ──────────────────────────────────────────────────────────── */
  function handleBlend(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const friend = JSON.parse(r.result);
        const mine   = { songs: [...state.likes].map(resolveTrack).filter(Boolean) };
        const result = ObsidianBlend.compare(mine, friend);
        const box    = $('#blend-results');
        if (box) box.innerHTML = `
          <div class="surface-card" style="margin-top:20px">
            <div class="eyebrow">TASTE MATCH</div>
            <h2 style="font-size:52px;margin:8px 0">${result.match}%</h2>
            <p>${result.shared.length} shared songs${result.artists.length
              ? ` · Artists: ${result.artists.map(safe).join(', ')}` : ''}</p>
            <button class="button" data-build-blend>Build Blend playlist</button>
          </div>`;
        window._blendData = { mine, friend, result };
      } catch { toast('Could not read that profile JSON.') }
    };
    r.readAsText(file);
  }

  /* ── Exports ──────────────────────────────────────────────────────────────── */
  function exportPlaylists() {
    const data = [...state.playlists.values()].map(p => ({
      name: p.name,
      tracks: p.list.toArray().map(({ id, title, artist, art, source, stream }) =>
        ({ id, title, artist, art, source, stream, remote: !!source })),
    }));
    download(data, 'obsidian-playlists.json');
  }

  function exportSinglePlaylist(id) {
    const p = state.playlists.get(id);
    if (!p) return;
    download([{ name: p.name, tracks: p.list.toArray() }], `${p.name.replace(/\s+/g, '-')}.json`);
  }

  function download(data, name) {
    const a  = document.createElement('a');
    a.href   = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importPlaylists(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        JSON.parse(r.result).forEach(p => {
          const id = 'pl:' + Date.now() + Math.random().toString(36).slice(2, 5);
          state.playlists.set(id, {
            id, name: p.name || 'Imported playlist',
            list: new ObsidianDS.PlaylistList(p.tracks || []),
          });
        });
        savePlaylists();
        render();
        toast('Playlists imported.');
      } catch { toast('That playlist file could not be read.') }
    };
    r.readAsText(file);
  }

  /* ── Sleep timer ──────────────────────────────────────────────────────────── */
  function setSleepTimer(minutes) {
    clearTimeout(state.sleepTimer);
    state.sleepTimer    = null;
    state.sleepMinutes  = 0;
    if (minutes > 0) {
      state.sleepMinutes = minutes;
      state.sleepTimer   = setTimeout(() => {
        currentEl().pause();
        state.sleepTimer   = null;
        state.sleepMinutes = 0;
        toast('Sleep timer: playback stopped.');
        if (state.page === 'settings') render();
      }, minutes * 60_000);
      toast(`Sleep timer set for ${minutes} minutes.`);
    } else {
      toast('Sleep timer off.');
    }
    /* Update status text */
    const sl = $('#sleep-status');
    if (sl) sl.textContent = minutes > 0 ? `Stops in ${minutes} min` : 'Off';
  }

  /* ── Diagnostics ──────────────────────────────────────────────────────────── */
  async function runDiagnostics() {
    const box = $('#diag-results');
    if (!box) return;
    box.innerHTML = '<p class="muted">Running checks…</p>';

    const online = navigator.onLine;
    const ctxState = sound.ctx ? sound.ctx.state : 'not created';
    const localCount = state.library.size;

    let audiusOk = false, itunesOk = false;
    if (online) {
      try {
        const d = await ObsidianAPI.diagnostics();
        audiusOk = d.audius;
        itunesOk = d.itunes;
      } catch {}
    }

    box.innerHTML = [
      ['Network', online ? 'Online' : 'Offline', online ? 'ok' : 'err'],
      ['Audius API', audiusOk ? 'Reachable' : (online ? 'Unreachable' : 'Offline'), audiusOk ? 'ok' : 'err'],
      ['iTunes API', itunesOk ? 'Reachable' : (online ? 'Unreachable' : 'Offline'), itunesOk ? 'ok' : 'err'],
      ['AudioContext', ctxState, ctxState === 'running' ? 'ok' : 'unk'],
      ['Local tracks', String(localCount), localCount > 0 ? 'ok' : 'unk'],
      ['Spatial mode', state.spatial, 'unk'],
    ].map(([label, value, status]) => `
      <div class="diag-row">
        <span>${safe(label)}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="muted" style="font-size:12px">${safe(value)}</span>
          <div class="diag-dot ${safe(status)}"></div>
        </div>
      </div>`).join('');
  }

  /* ── 3D card tilt effect ──────────────────────────────────────────────────── */
  function attachCardTilt() {
    if (store.read('reduce3d', matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    $$('.track-card').forEach(card => {
      card.addEventListener('mousemove', e => {
        const r = card.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width  - 0.5) * 14; /* ±7 deg */
        const y = ((e.clientY - r.top)  / r.height - 0.5) * -14;
        /* Set highlight position as CSS vars */
        card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width * 100).toFixed(1)}%`);
        card.style.setProperty('--my', `${((e.clientY - r.top)  / r.height * 100).toFixed(1)}%`);
        card.style.transform = `perspective(600px) rotateY(${x}deg) rotateX(${y}deg) translateZ(6px)`;
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
      });
    });
  }

  /* ── Audio events ─────────────────────────────────────────────────────────── */

  function setupAudioEvents(el) {
    el.addEventListener('timeupdate', () => {
      if (el !== currentEl()) return;
      const dur  = el.duration || 0;
      $('#seek').value              = dur ? (el.currentTime / dur * 1000) : 0;
      $('#current-time').textContent = fmt(el.currentTime);
      $('#duration').textContent     = fmt(dur);

      /* DSA: binary search for synced lyric line */
      const timed = state.lyrics.every(l => Number.isFinite(l.time));
      const idx   = timed ? ObsidianDS.lyricSearch(state.lyrics, el.currentTime) : -1;
      if (idx !== state.lyricIndex) {
        state.lyricIndex = idx;
        $$('.lyric-line').forEach((x, n) => {
          x.classList.toggle('current', n === idx);
          if (n === idx) x.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
    });

    el.addEventListener('ended', () => {
      const vinyl = $('.now-vinyl');
      if (vinyl) vinyl.style.setProperty('--vinyl-state', 'paused');
      if (state.repeat === 2) {       /* Repeat one */
        el.currentTime = 0; el.play();
      } else {
        next();
      }
    });

    el.addEventListener('play',  () => {
      $('#play-button').textContent = 'Ⅱ';
      const vinyl = $('.now-vinyl');
      if (vinyl) vinyl.style.setProperty('--vinyl-state', 'running');
    });
    el.addEventListener('pause', () => {
      $('#play-button').textContent = '▶';
      const vinyl = $('.now-vinyl');
      if (vinyl) vinyl.style.setProperty('--vinyl-state', 'paused');
    });
  }

  setupAudioEvents(local);
  setupAudioEvents(remote);

  /* ── Global click handler ─────────────────────────────────────────────────── */

  function clickHandler(e) {
    const b = e.target.closest('[data-play],[data-playlist],[data-mood],[data-genre],button,[tabindex]');
    if (!b) return;

    /* Navigation */
    if (b.dataset.page)        { state.page = b.dataset.page; render(); return }
    if (b.dataset.mood)        { state.mood = b.dataset.mood; store.write('mood', state.mood); setTheme(); render(); return }
    if (b.dataset.dismiss)     { store.write(b.dataset.dismiss, false); render(); return }
    if (b.id === 'theme-toggle') {
      const all = ['morning','afternoon','evening','night'];
      state.theme = all[(all.indexOf(document.documentElement.dataset.time) + 1) % all.length];
      store.write('theme', state.theme);
      setTheme();
      return;
    }
    if (b.id === 'top-mood') {
      state.mood = moods[(moods.indexOf(state.mood) + 1) % moods.length];
      store.write('mood', state.mood);
      setTheme();
      render();
      return;
    }

    /* Genre */
    if (b.dataset.genre) {
      state.page  = 'explore';
      state.genre = b.dataset.genre;
      render();
      refreshOnline(state.genre);
      return;
    }
    if (b.dataset.clearGenre) { state.genre = ''; render(); refreshOnline(); return }
    if (b.dataset.refresh)    { refreshOnline(state.genre); return }

    /* File add — BUG FIX B9: use .click() on inputs that are off-screen, not display:none */
    if (b.id === 'btn-files' || b.id === 'btn-files-empty' || b.dataset.files)  { fileInput.click();   return }
    if (b.id === 'btn-folder' || b.dataset.folder) { folderInput.click(); return }

    /* Like */
    if (b.dataset.like)  { like(b.dataset.like); return }

    /* Queue — DSA: Queue.enqueue() */
    if (b.dataset.queue) {
      const t = resolveTrack(b.dataset.queue);
      if (t) { state.queue.enqueue(t); toast('Added to Up Next.') }
      return;
    }

    /* Add to playlist */
    if (b.dataset.addTrack) {
      const t = resolveTrack(b.dataset.addTrack);
      if (!t) return;
      if (!state.playlists.size) { toast('Create a playlist first.'); state.page = 'playlists'; render(); return }
      const names = [...state.playlists.values()].map((p, i) => `${i + 1}. ${p.name}`).join('\n');
      const n     = Number(prompt('Add to which playlist?\n' + names)) - 1;
      const p     = [...state.playlists.values()][n];
      if (p) { p.list.add(t); savePlaylists(); toast('Added to ' + p.name + '.') }
      return;
    }

    /* Remove from playlist */
    if (b.dataset.removeTrack) {
      const [pid, tid] = b.dataset.removeTrack.split('|');
      const p = state.playlists.get(pid);
      if (p) { p.list.remove(tid); savePlaylists(); showPlaylist(pid) }
      return;
    }

    /* Play */
    if (b.dataset.play) {
      const t = resolveTrack(b.dataset.play);
      if (t) play(t);
      return;
    }

    /* Play button */
    if (b.id === 'play-button') {
      if (currentEl().src) {
        currentEl().paused ? currentEl().play() : currentEl().pause();
      } else if (state.order.head) {
        play(state.order.head.value);
      } else {
        toast('Add a song from your device or Explore.');
      }
      return;
    }

    if (b.id === 'next-button')     { next();     return }
    if (b.id === 'previous-button') { previous(); return }

    if (b.id === 'shuffle-button') {
      state.shuffle = !state.shuffle;
      b.classList.toggle('on', state.shuffle);
      return;
    }
    if (b.id === 'repeat-button') {
      state.repeat = (state.repeat + 1) % 3;
      b.classList.toggle('on', state.repeat > 0);
      b.title = ['Repeat off', 'Repeat all', 'Repeat one'][state.repeat];
      b.textContent = ['↻', '↺', '➀'][state.repeat];
      return;
    }

    if (b.id === 'queue-button')  { openDrawer();    return }
    if (b.dataset.closeDrawer)    { closeDrawer();   return }
    if (b.id === 'lyrics-button') { openLyrics();    return }

    /* Spatial */
    if (b.id === 'spatial-button') {
      const modes = ['off','wide','surround','8d'];
      state.spatial = modes[(modes.indexOf(state.spatial) + 1) % modes.length];
      store.write('spatial', state.spatial);
      b.classList.toggle('active', state.spatial !== 'off');
      b.title   = 'Spatial Sound: ' + state.spatial;
      b.querySelector('span').textContent = state.spatial === 'off' ? 'Spatial' : state.spatial;
      sound.mode = state.spatial;
      if (state.spatial !== 'off') {
        sound.apply(currentEl()).then(ok => {
          if (!ok) toast('Spatial Sound unavailable for this track.');
          else toast('Spatial Sound: ' + state.spatial);
        });
      }
      return;
    }

    if (b.id === 'like-current') { if (state.current) like(state.current.id); return }

    /* Mini art -> now playing view */
    if (b.id === 'player-art' || b.closest('#player-art')) { openNowPlaying(); return }

    /* Playlist actions */
    if (b.dataset.createPlaylist) {
      const name = prompt('Name your playlist');
      if (name?.trim()) {
        const id = 'pl:' + Date.now();
        state.playlists.set(id, { id, name: name.trim(), list: new ObsidianDS.PlaylistList() });
        savePlaylists();
        render();
      }
      return;
    }

    if (b.dataset.playlist) {
      if (state.page !== 'playlists') { state.page = 'playlists'; render() }
      showPlaylist(b.dataset.playlist);
      return;
    }

    /* BUG FIX B8: was reading b.dataset.playlist instead of b.dataset.playlistPlay */
    if (b.dataset.playlistPlay) {
      const p = state.playlists.get(b.dataset.playlistPlay);
      if (p) setOrderPlay(p.list.toArray());
      return;
    }

    if (b.dataset.shufflePlaylist) {
      const p = state.playlists.get(b.dataset.shufflePlaylist);
      if (p) {
        state.shuffle = true;
        setOrderPlay(p.list.toArray().sort(() => Math.random() - .5));
      }
      return;
    }

    if (b.dataset.rename) {
      const p = state.playlists.get(b.dataset.rename);
      if (!p) return;
      const n = prompt('Rename playlist', p.name);
      if (n?.trim()) { p.name = n.trim(); savePlaylists(); render() }
      return;
    }

    if (b.dataset.delete) {
      if (confirm('Delete this playlist?')) {
        state.playlists.delete(b.dataset.delete);
        savePlaylists();
        render();
      }
      return;
    }

    if (b.dataset.playAll) {
      const list = b.dataset.playAll === 'liked'
        ? [...state.likes].map(resolveTrack).filter(Boolean)
        : [];
      setOrderPlay(list);
      return;
    }
    if (b.dataset.shuffleAll) {
      state.shuffle = true;
      const list = [...state.likes].map(resolveTrack).filter(Boolean)
        .sort(() => Math.random() - .5);
      setOrderPlay(list);
      return;
    }

    if (b.dataset.export)         { exportPlaylists();               return }
    if (b.dataset.import)         { $('#import-input')?.click();     return }
    if (b.dataset.exportPlaylist) { exportSinglePlaylist(b.dataset.exportPlaylist); return }
    if (b.dataset.profileExport)  { ObsidianBlend.exportProfile(state.tracks, state.likes); return }
    if (b.dataset.profileImport)  { $('#profile-input')?.click();    return }

    if (b.dataset.pasteLyrics)    { pasteLyrics(); return }
    if (b.dataset.saveLyrics) {
      const txt = $('#lyrics-input').value;
      store.write('lyrics:' + state.current.id, txt);
      state.lyrics    = ObsidianLyrics.parse(txt);
      state.lyricIndex = -2;
      lyricsModal(state.lyrics);
      return;
    }

    if (b.dataset.modalClose || e.target.matches('[data-backdrop]') || b.matches('[data-backdrop]')) {
      $('#modal-root').innerHTML = '';
      return;
    }

    if (b.dataset.lyric != null) {
      const l = state.lyrics[+b.dataset.lyric];
      if (l && Number.isFinite(l.time)) currentEl().currentTime = l.time;
      return;
    }

    if (b.dataset.premium) {
      $('#premium-badge').classList.remove('hidden');
      toast('Premium demo badge enabled.');
      return;
    }

    if (b.dataset.buildBlend) {
      if (!window._blendData) return;
      const { mine, result } = window._blendData;
      /* DSA: Set intersection/union already computed in blend.js */
      const songs = [
        ...result.shared.map(key => mine.songs.find(s => ObsidianBlend.keyOf(s) === key)).filter(Boolean),
      ];
      for (let i = 0; i < Math.max(result.mine.length, result.friend.length); i++) {
        if (result.mine[i])   songs.push(result.mine[i]);
        if (result.friend[i]) songs.push(result.friend[i]);
      }
      const id = 'pl:' + Date.now();
      state.playlists.set(id, { id, name: 'Our Blend', list: new ObsidianDS.PlaylistList(songs) });
      savePlaylists();
      toast('Blend playlist saved to Playlists.');
      return;
    }

    if (b.dataset.addCurrent) {
      const p = state.playlists.get(b.dataset.addCurrent);
      if (!state.current) { toast('Play a song first, then add it here.'); return }
      if (p) { p.list.add(state.current); savePlaylists(); showPlaylist(p.id); toast('Added to playlist.') }
      return;
    }

    if (b.dataset.sleep != null) { setSleepTimer(+b.dataset.sleep); return }
    if (b.dataset.runDiag)       { runDiagnostics(); return }
  }

  /* ── Event bindings ───────────────────────────────────────────────────────── */

  /* Navigation and content clicks */
  $('#content').addEventListener('click',        clickHandler);
  $('#modal-root').addEventListener('click',      clickHandler);
  $('#drawer').addEventListener('click',          clickHandler);
  $('#main-nav').addEventListener('click',        clickHandler);
  $('#sidebar-playlists').addEventListener('click', clickHandler);
  $('.topbar').addEventListener('click',          clickHandler);
  $('.brand').addEventListener('click', e => { e.preventDefault(); state.page = 'home'; render() });
  document.addEventListener('click', e => { if (e.target.closest('#player')) clickHandler(e) });

  /* File input changes */
  document.addEventListener('change', e => {
    const input = e.target;
    if (!input.matches('input[type="file"]')) return;
    if (input.id === 'import-input'  && input.files[0]) importPlaylists(input.files[0]);
    if (input.id === 'profile-input' && input.files[0]) handleBlend(input.files[0]);
  });

  /* Settings changes */
  $('#content').addEventListener('change', e => {
    if (e.target.id === 'theme-select') {
      state.theme = e.target.value === 'auto' ? null : e.target.value;
      store.write('theme', state.theme);
      setTheme();
    }
    if (e.target.id === 'mood-select') {
      state.mood = e.target.value;
      store.write('mood', state.mood);
      setTheme();
    }
    if (e.target.id === 'reduce-motion') {
      document.body.classList.toggle('reduce-3d', e.target.checked);
      store.write('reduce3d', e.target.checked);
    }
    if (e.target.id === 'spatial-select') {
      state.spatial = e.target.value;
      store.write('spatial', state.spatial);
      sound.mode = state.spatial;
      if (state.spatial !== 'off') sound.apply(currentEl());
    }
    if (e.target.id === 'crossfade-input') {
      state.crossfade = +e.target.value;
      store.write('crossfade', state.crossfade);
      const lbl = $('#crossfade-val');
      if (lbl) lbl.textContent = `${state.crossfade}s between tracks`;
    }
  });

  /* Drawer scrim close */
  $('#drawer-scrim').addEventListener('click', closeDrawer);

  /* Seek and volume */
  $('#seek').addEventListener('input', e => {
    const el = currentEl();
    if (el.duration) el.currentTime = el.duration * +e.target.value / 1000;
  });
  $('#volume').addEventListener('input', e => {
    local.volume = remote.volume = +e.target.value;
    store.write('volume', +e.target.value);
  });
  $('#mute-button').addEventListener('click', e => {
    const muted = !currentEl().muted;
    local.muted = remote.muted = muted;
    e.currentTarget.textContent = muted ? '◖×' : '◖))';
  });

  /* Global search bar */
  $('#global-search').addEventListener('input', e => {
    state.page = 'search';
    render();
    const q = e.target.value;
    const ps = $('#page-search');
    if (ps) ps.value = q;
  });
  $('#global-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(_searchTimer);
      state.page = 'search';
      render();
      const ps = $('#page-search');
      if (ps) ps.value = e.target.value;
      onlineSearch(e.target.value);
    }
  });
  $('#content').addEventListener('input', e => {
    if (e.target.id === 'page-search') {
      const q = e.target.value;
      $('#global-search').value = q;
      renderLocalSearch(q);
      queueOnlineSearch(q);
    }
  });

  /* Keyboard shortcuts */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('#modal-root').innerHTML = '';
      closeDrawer();
      if (e.target.matches('input,textarea,select')) e.target.blur();
      return;
    }
    if (e.target.matches('input,textarea,select')) return;

    if (e.code === 'Space') {
      e.preventDefault();
      currentEl().paused ? currentEl().play() : currentEl().pause();
    }
    if (e.shiftKey && e.key === 'ArrowRight') next();
    if (e.shiftKey && e.key === 'ArrowLeft')  previous();
    if (e.key === '/') { e.preventDefault(); $('#global-search').focus() }
    if (e.key.toLowerCase() === 'l') openLyrics();
    if (e.key.toLowerCase() === 'm') $('#mute-button').click();
    if (e.key.toLowerCase() === 'n') openNowPlaying();

    /* Arrow navigation through card grid — DSA: 2D cardGrid array */
    if (e.key.startsWith('Arrow') && !e.shiftKey) {
      const cards = $$('.track-card[tabindex="0"]');
      const i     = cards.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, Math.round(
        $$('.track-grid')[0]?.clientWidth / (cards[0]?.clientWidth + 14) || 1
      ));
      /* DSA: cardGrid builds a 2D array for 2D keyboard navigation */
      const grid = ObsidianDS.cardGrid(cards, cols);
      let r      = grid.findIndex(row => row.includes(cards[i]));
      let c      = grid[r].indexOf(cards[i]);
      if (e.key === 'ArrowRight') c++;
      if (e.key === 'ArrowLeft')  c--;
      if (e.key === 'ArrowDown')  r++;
      if (e.key === 'ArrowUp')    r--;
      if (grid[r]?.[c]) { e.preventDefault(); grid[r][c].focus() }
    }
  });

  /* Online / offline banner */
  window.addEventListener('online',  () => { $('#offline-banner').classList.add('hidden'); if (state.page === 'home') refreshOnline() });
  window.addEventListener('offline', () => { $('#offline-banner').classList.remove('hidden') });
  if (!navigator.onLine) $('#offline-banner').classList.remove('hidden');

  /* reduce-3d initial state */
  document.body.classList.toggle('reduce-3d',
    store.read('reduce3d', matchMedia('(prefers-reduced-motion: reduce)').matches)
  );

  /* ── Boot ─────────────────────────────────────────────────────────────────── */
  render();
  refreshOnline();

})();
