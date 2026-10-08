# Obsidian — Music, in Focus

Obsidian is an offline-first music player and playlist manager built with plain HTML, CSS, and JavaScript for a C++ / data-structures course. It opens directly from `index.html` — no build step, no server, no account.

---

## Run it

### Option A — Double-click (file://)
Open `index.html` in any modern Chromium-based browser (Chrome 90+, Edge 90+, Brave).
Firefox works for local files; folder picker (`webkitdirectory`) is Chromium-only.

### Option B — Local server (recommended for online features)
```sh
python -m http.server 8080
# then open http://localhost:8080
```
Or with Node: `npx -y serve .`

A local server avoids some browser CORS restrictions on localhost and lets `<audio crossorigin>` work correctly.

---

## Where music goes

The `music/` folder is an optional place to organise your own audio files. Browsers **cannot** scan a folder automatically — use the **Add folder** picker in My Music instead.

Supported formats: MP3, M4A, WAV, OGG, FLAC, AAC, Opus.

### Filename convention
`Artist — Title.mp3` fills in the artist and title automatically. Any separator (` - `, ` – `, ` — `) works.

### Synced lyrics
Keep an `.lrc` sidecar file beside its audio file with the same base name:
```
Mira Sol — Sunroom.mp3
Mira Sol — Sunroom.lrc
```
You can also paste LRC or plain text lyrics from the ♪ button in the player bar.

---

## Online music sources

| Source | What you get | Limit |
|--------|-------------|-------|
| **Audius** | Full-length independent tracks | CORS may block Spatial Sound on some tracks |
| **iTunes** | 30-second previews with high-res artwork | Preview only, not full tracks |

Audius is tried first; iTunes is the fallback. Results are cached in memory for the current session. Both require an internet connection.

---

## Data structures — where each one is used

| Structure | JavaScript | C++ | Purpose |
|-----------|-----------|-----|---------|
| Doubly linked list | `js/ds.js · PlaylistList` | `cpp/playlist_manager.cpp · Playlist` | Ordered play queue with wrap-around next/previous |
| Stack | `js/ds.js · Stack` | `std::stack` | Play history; Previous button pops the top |
| Queue | `js/ds.js · Queue` | `std::queue` | Up Next — tracks requested before normal order |
| Map | `js/app.js · state.library / playlists / tracks`; `js/api.js · cache` | `std::map` | O(1) track / playlist lookup; session API cache |
| Set | `js/app.js · state.likes`; `js/blend.js`; `js/app.js · nospatialTracks` | `std::set` | Liked IDs, Blend intersection/union |
| KMP (from scratch) | `js/ds.js · kmp` | `kmp()` in `cpp/playlist_manager.cpp` | Literal local search without built-in substring matching |
| Wildcard regex | `js/ds.js · wildcardMatch` | — | `*` searches like `lo*fi` |
| 2D array | `js/ds.js · cardGrid`; `js/audio.js · matrix` | `vector<vector<string>> cardGrid` | Keyboard navigation of card grids; rolling spectrogram |
| Binary search | `js/ds.js · lyricSearch` | — | Find the synced lyric line at the current timestamp |
| Regex | `js/app.js · addFiles()`, `js/lyrics.js` | — | Filename parsing; LRC timestamp parsing |

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Shift + →` | Next track |
| `Shift + ←` | Previous track |
| `/` | Focus search bar |
| `L` | Open Lyrics |
| `M` | Toggle mute |
| `N` | Open Now Playing view |
| `Esc` | Close modal / drawer |
| `Arrow keys` | Navigate card grid |

---

## Limits (be honest in the viva)

- **Spatial Sound is not Dolby Atmos.** Dolby Atmos is a licensed, proprietary codec that browsers cannot decode. Obsidian's "Spatial Sound" is a browser Web Audio effect using `PannerNode` (HRTF model) and `StereoPanner`.
- **CORS may block Spatial Sound on some online tracks.** When Audius or iTunes streams do not send `Access-Control-Allow-Origin` headers, `createMediaElementSource` cannot process the audio. Obsidian detects this, retries without `crossOrigin`, and shows a notice instead of going silent.
- **iTunes previews are 30 seconds.** The iTunes Search API is free and public but only returns preview clips.
- **`webkitdirectory` is Chromium-first.** Folder picking works in Chrome, Edge, and Brave. Firefox offers individual file selection only.
- **Browsers forget local file handles after a page reload.** Object URLs created with `URL.createObjectURL()` are valid only for the current session. Obsidian saves track metadata but not the file itself; re-add the folder after reopening. (The File System Access API `showDirectoryPicker()` would fix this in Chromium but is deliberately kept optional here for `file://` compatibility.)
- **ID3 USLT parsing is best-effort.** The hand-written ID3v2 reader handles the most common case (USLT frame in ID3v2.3/2.4). Sidecar `.lrc` and pasted lyrics are more reliable.
- **The visualizer uses real FFT data** from a `AnalyserNode` when the Web Audio graph is active. When spatial sound is off and no audio graph has been created, it falls back to an animated placeholder.

---

## Why use this instead of Spotify?

- Plays files you already own — no subscription, no ads, no internet required
- Keeps lyrics, Blend, and playlists fully offline
- Exports portable playlists as JSON you can share or back up
- Makes every data-structure decision visible in the source for a viva
- Respects your privacy: nothing leaves your device

---

## Compile the C++ edition

```sh
g++ -std=c++17 -Wall -Wextra cpp/playlist_manager.cpp -o playlist_manager
./playlist_manager
```

The console menu demonstrates every data structure: DLL playlist, stack history, queue, std::map library, std::set Blend, KMP search, and a 2D card grid.

---

## Project structure

```
MusicApp/
├── index.html          — single-page app shell
├── css/
│   ├── themes.css      — time-of-day palettes + mood accents (CSS custom properties)
│   └── style.css       — full design system, layout, responsive, animations
├── js/
│   ├── ds.js           — all data structures with header comments
│   ├── api.js          — Audius + iTunes fetch helpers, session cache
│   ├── audio.js        — Web Audio graph, spatial sound, visualizer
│   ├── lyrics.js       — LRC parser + ID3 USLT reader
│   ├── blend.js        — profile export/import + Set-based taste match
│   └── app.js          — UI state, playback, navigation, all event handlers
├── cpp/
│   └── playlist_manager.cpp — C++17 console companion
└── music/              — optional folder for your own files
```
