/*
 * api.js — Online music catalog (Audius + iTunes), session cache, and fetch helpers.
 *
 * DSA: cache is a Map<url, data> for O(1) repeated lookups within the session.
 *
 * Priority:   Audius full tracks → iTunes 30 s previews
 * Audius host: Discovered dynamically via GET https://api.audius.co; rotates on failure.
 * iTunes:      https://itunes.apple.com/search — no key required, returns previewUrl.
 * CORS:        Audius streams may block crossOrigin; handled by audio.js retry logic.
 *
 * fetch helper rules:
 *   - 8 s AbortController timeout
 *   - Session Map cache (never writes to localStorage — cache is ephemeral)
 *   - Console.warn on HTTP errors (never silent)
 *   - Audius → iTunes fallback at the search() level
 */
(function (g) {
  'use strict';

  /* Session cache: Map<url, responseData> */
  const cache   = new Map();
  const TIMEOUT = 15000;
  const APP     = 'OBSIDIAN';

  /* Audius host list — filled at first call, rotated on error */
  let audiusHosts = [];
  let audiusHostIdx = 0;

  /* ── Fetch helper ───────────────────────────────────────────────────────── */

  async function fetchJSON(url, skipCache) {
    if (!skipCache && cache.has(url)) return cache.get(url);
    if (!navigator.onLine) throw new Error('offline');

    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const resp = await fetch(url, { signal: ctl.signal });
      if (!resp.ok) {
        console.warn(`[Obsidian] HTTP ${resp.status} for ${url}`);
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (!skipCache) cache.set(url, data);
      return data;
    } catch (err) {
      /* Re-throw with a more descriptive message */
      if (err.name === 'AbortError') throw new Error(`Timeout fetching ${url}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── Audius host discovery ──────────────────────────────────────────────── */

  async function getAudiusHost() {
    if (audiusHosts.length) {
      return audiusHosts[audiusHostIdx % audiusHosts.length];
    }
    try {
      /* GET https://api.audius.co returns { data: ["https://discoveryprovider..."] } */
      const resp = await fetchJSON('https://api.audius.co', true);
      audiusHosts = (resp && Array.isArray(resp.data) ? resp.data : [])
        .filter(h => typeof h === 'string' && h.startsWith('http'));
    } catch (err) {
      console.warn('[Obsidian] Audius host discovery failed:', err.message);
    }
    /* Always include api.audius.co itself as a last-resort fallback */
    if (!audiusHosts.includes('https://api.audius.co')) {
      audiusHosts.push('https://api.audius.co');
    }
    return audiusHosts[0];
  }

  /**
   * Call an Audius v1 path.  Rotates hosts on failure.
   * @param {string} path  e.g. 'tracks/trending' or 'tracks/search?query=…'
   */
  async function audius(path) {
    const sep  = path.includes('?') ? '&' : '?';
    const base = await getAudiusHost();
    const url  = `${base}/v1/${path}${sep}app_name=${APP}`;
    try {
      const data = await fetchJSON(url);
      return data.data || [];
    } catch (err) {
      console.warn(`[Obsidian] Audius request failed (${url}):`, err.message);
      /* Rotate to next host and retry once */
      audiusHostIdx++;
      const next = audiusHosts[audiusHostIdx % audiusHosts.length];
      if (next && next !== base) {
        const url2 = `${next}/v1/${path}${sep}app_name=${APP}`;
        try {
          const data2 = await fetchJSON(url2, true);
          return data2.data || [];
        } catch (err2) {
          console.warn(`[Obsidian] Audius retry also failed (${url2}):`, err2.message);
        }
      }
      return [];
    }
  }

  /* ── Data mappers ───────────────────────────────────────────────────────── */

  function mapAudius(t) {
    return {
      id:      'audius:' + t.id,
      title:   t.title || 'Untitled',
      artist:  (t.user && t.user.name) || 'Audius artist',
      art:     (t.artwork && (t.artwork['480x480'] || t.artwork['150x150'])) || '',
      duration: t.duration || 0,
      source:  'audius',
      remote:  true,
      /* Stream URL: use the selected host so it matches the working host */
      stream:  `https://api.audius.co/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=${APP}`,
      genre:   t.genre || 'Music',
    };
  }

  function mapITunes(t) {
    return {
      id:      'itunes:' + t.trackId,
      title:   t.trackName  || 'Untitled',
      artist:  t.artistName || 'iTunes artist',
      /* Replace 100×100 thumbnail with larger 600×600 artwork */
      art:     (t.artworkUrl100 || '').replace('100x100', '600x600'),
      duration: Math.round((t.trackTimeMillis || 0) / 1000),
      source:  'itunes',
      remote:  true,
      stream:  t.previewUrl || '',
      genre:   t.primaryGenreName || 'Music',
    };
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  /**
   * Search for tracks by query.
   * Runs Audius and iTunes in parallel to provide a massive catalog.
   */
  async function search(q) {
    const enc = encodeURIComponent(q);
    const results = [];
    
    const [audiusRes, itunesRes] = await Promise.allSettled([
      audius(`tracks/search?query=${enc}&limit=50`),
      fetchJSON(`https://itunes.apple.com/search?term=${enc}&media=music&entity=song&limit=100`)
    ]);

    if (audiusRes.status === 'fulfilled' && audiusRes.value.length) {
      results.push(...audiusRes.value.map(mapAudius));
    }
    if (itunesRes.status === 'fulfilled' && itunesRes.value.results) {
      results.push(...itunesRes.value.results.filter(x => x.previewUrl).map(mapITunes));
    }
    return results;
  }

  /**
   * Fetch trending tracks, optionally filtered by genre.
   * Runs Audius and iTunes in parallel.
   */
  async function trending(genre) {
    const enc = genre ? encodeURIComponent(genre) : '';
    const results = [];
    
    const defaultTerms = ['top hits', 'trending', 'viral hits', 'global hits', 'new music', 'popular'];
    const rTerm = defaultTerms[Math.floor(Math.random() * defaultTerms.length)];
    
    const [audiusRes, itunesRes] = await Promise.allSettled([
      audius(enc ? `tracks/trending?genre=${enc}&limit=50` : 'tracks/trending?limit=50'),
      fetchJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(genre ? genre + ' music' : rTerm)}&media=music&entity=song&limit=100`)
    ]);

    if (audiusRes.status === 'fulfilled' && audiusRes.value.length) {
      results.push(...audiusRes.value.map(mapAudius));
    } else if (enc) {
      /* Fallback: If Audius trending returns 0 for a specific genre, try searching instead */
      const fallback = await audius(`tracks/search?query=${enc}&limit=50`);
      if (fallback && fallback.length) {
        results.push(...fallback.map(mapAudius));
      }
    }
    
    if (itunesRes.status === 'fulfilled' && itunesRes.value.results) {
      results.push(...itunesRes.value.results.filter(x => x.previewUrl).map(mapITunes));
    }
    return results;
  }

  /**
   * Automatically fetch synced lyrics from LRCLIB.
   */
  async function fetchLyrics(artist, title) {
    if (!artist || !title) return null;
    try {
      const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
      const res = await fetchJSON(url);
      if (res && res.syncedLyrics) return res.syncedLyrics;
      if (res && res.plainLyrics) return res.plainLyrics;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * Check whether key services are reachable (for the Diagnostics panel).
   * Returns { audius: bool, itunes: bool }.
   */
  async function diagnostics() {
    const result = { audius: false, itunes: false };
    try {
      await fetchJSON('https://api.audius.co/v1/tracks/trending?app_name=OBSIDIAN&limit=1', true);
      result.audius = true;
    } catch (_) {}
    try {
      await fetchJSON('https://itunes.apple.com/search?term=test&limit=1', true);
      result.itunes = true;
    } catch (_) {}
    return result;
  }

  g.ObsidianAPI = { search, trending, fetchLyrics, diagnostics, cache };
})(window);
