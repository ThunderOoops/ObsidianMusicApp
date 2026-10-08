/*
 * audio.js — Web Audio graph, spatial sound modes, and canvas visualizer.
 *
 * Architecture:
 *   #local-audio  — local files (no crossOrigin, no CORS concern)
 *   #remote-audio — remote streams (crossOrigin="anonymous", CORS may fail)
 *
 * Web Audio chain per element (only created once, cached in WeakMap):
 *   MediaElementSource -> bass shelf (BiquadFilter) -> stereo widener (StereoPanner)
 *   -> panner (PannerNode, HRTF) -> compressor -> analyser -> destination
 *
 * CRITICAL rules:
 *   1. createMediaElementSource is called ONCE per element; the result is cached.
 *   2. If a remote element gets a CORS error we retry WITHOUT crossOrigin,
 *      mark the track "not spatializable", and route audio directly without the Web Audio graph.
 *   3. AudioContext is created on the first user gesture (not at load time).
 *   4. The requestAnimationFrame loop for 8D rotation stores its ID so it can be cancelled.
 *
 * DSA note: spectrogram is a 2D rolling array (time × frequency) driven by AnalyserNode FFT data.
 */
(function (g) {
  'use strict';

  class SoundEngine {
    constructor(local, remote) {
      this.local   = local;
      this.remote  = remote;
      this.ctx     = null;
      /* WeakMap: element -> { src, bass, pan, panner, comp, analyser } */
      this.nodes   = new WeakMap();
      /* Set of elements that failed CORS and cannot be put through Web Audio */
      this.noSpatial = new WeakSet();
      this.mode    = 'off';
      this.angle   = 0;
      this._rotId  = null;       /* RAF id for 8D loop — cancel on mode change */
      this.matrix  = [];         /* 2D spectrogram: rows=time, cols=frequency bins */
      this.canvas  = document.getElementById('visualizer');
      this._initDraw();

      /* If a remote stream errors with CORS blocked, retry without crossOrigin. */
      remote.addEventListener('error', () => this._handleRemoteError());
    }

    /* ── AudioContext + graph setup ─────────────────────────────────────────── */

    /** Create the AudioContext on first use (must be inside a user gesture call chain). */
    _ensureCtx() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    /**
     * Build the Web Audio graph for `el` once.
     * Returns the cached node bundle, or null if the element is marked noSpatial.
     */
    setup(el) {
      if (!el) return null;
      if (this.noSpatial.has(el)) return null;
      if (this.nodes.has(el)) return this.nodes.get(el);
      try {
        const ctx  = this._ensureCtx();
        const src  = ctx.createMediaElementSource(el);   /* must only be called once */
        const bass = ctx.createBiquadFilter();
        bass.type = 'lowshelf';
        bass.frequency.value = 180;
        bass.gain.value = 2;                              /* gentle bass boost */

        const widener = ctx.createBiquadFilter();
        widener.type = 'highshelf';
        widener.frequency.value = 8000;
        widener.gain.value = 1.5;

        const pan    = ctx.createStereoPanner();
        const panner = ctx.createPanner();
        panner.panningModel  = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance   = 1;

        const comp   = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value      = 6;
        comp.ratio.value     = 3;
        comp.attack.value    = 0.003;
        comp.release.value   = 0.2;

        const analyser = ctx.createAnalyser();
        analyser.fftSize         = 256;
        analyser.smoothingTimeConstant = 0.8;

        /* Connect the chain */
        src.connect(bass);
        bass.connect(widener);
        widener.connect(pan);
        pan.connect(panner);
        panner.connect(comp);
        comp.connect(analyser);
        analyser.connect(ctx.destination);

        const bundle = { src, bass, widener, pan, panner, comp, analyser };
        this.nodes.set(el, bundle);
        return bundle;
      } catch (err) {
        console.warn('[Obsidian] Web Audio setup failed:', err.message);
        this.noSpatial.add(el);
        return null;
      }
    }

    /**
     * Resume context and apply the chosen spatial mode to `el`.
     * Called every time the user changes tracks or spatial mode.
     * Returns true if spatial processing is active.
     */
    async apply(el) {
      if (!el) return false;
      if (this.mode === 'off') return false;
      if (this.noSpatial.has(el)) return false;

      const n = this.setup(el);
      if (!n) return false;

      /* Cancel any running 8D rotation loop */
      if (this._rotId) { cancelAnimationFrame(this._rotId); this._rotId = null; }

      switch (this.mode) {
        case 'wide':
          n.pan.pan.value = 0;
          n.panner.positionX.value = 0;
          n.panner.positionY.value = 0;
          n.panner.positionZ.value = -1;
          n.widener.gain.value = 4;        /* wider stereo image */
          break;
        case 'surround':
          n.pan.pan.value = 0;
          n.panner.positionX.value = 0;
          n.panner.positionY.value = 1;    /* slightly above */
          n.panner.positionZ.value = -1;
          n.widener.gain.value = 2;
          break;
        case '8d':
          n.widener.gain.value = 1.5;
          this._rotate(n);
          break;
      }
      return true;
    }

    /* ── 8D rotation loop ───────────────────────────────────────────────────── */

    _rotate(n) {
      if (this.mode !== '8d' || !n) return;
      this.angle += 0.011;
      n.panner.positionX.value = Math.cos(this.angle) * 2;
      n.panner.positionZ.value = Math.sin(this.angle) * 2;
      n.panner.positionY.value = Math.sin(this.angle * 0.5) * 0.5;
      this._rotId = requestAnimationFrame(() => this._rotate(n));
    }

    /* ── CORS retry logic ───────────────────────────────────────────────────── */

    _handleRemoteError() {
      /* Only retry once; if crossOrigin was "anonymous" and it failed, try without it. */
      if (this.remote.crossOrigin === 'anonymous' && this.remote.src) {
        console.warn('[Obsidian] Remote audio CORS error — retrying without crossOrigin');
        this.noSpatial.add(this.remote);
        const savedSrc = this.remote.src;
        this.remote.removeAttribute('crossorigin');
        this.remote.src = savedSrc;
        this.remote.load();
        this.remote.play().catch(() => {});
        /* Inform the UI — app.js listens for 'obsidian:nospatial' */
        this.remote.dispatchEvent(new CustomEvent('obsidian:nospatial', { bubbles: true }));
      }
    }

    /* ── EQ helpers (called from app.js) ───────────────────────────────────── */

    setEQ(el, bass, mid, treble) {
      const n = this.nodes.get(el);
      if (!n) return;
      n.bass.gain.value = bass;
      /* mid: use a dedicated peaking filter if we have one, else skip */
      n.widener.gain.value = treble;
    }

    /* ── Canvas visualizer ──────────────────────────────────────────────────── */

    _initDraw() {
      const c = this.canvas;
      if (!c) return;
      const ctx = c.getContext('2d');
      let phase = 0;

      const tick = () => {
        const w = c.width, h = c.height;
        ctx.clearRect(0, 0, w, h);

        const n = this._activeNodes();
        let sample;

        const data = n && n.analyser ? new Uint8Array(n.analyser.frequencyBinCount) : null;
        if (data) {
          n.analyser.getByteFrequencyData(data);
          const step = Math.floor(data.length / 20);
          sample = Array.from({ length: 20 }, (_, i) => (data[i * step] / 255) * (h - 4) + 4);
        } else {
          phase += 0.07;
          sample = Array.from({ length: 20 }, (_, i) => 4 + Math.abs(Math.sin(phase + i * 0.55)) * (h - 6));
        }

        const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#7C5CFF';
        ctx.fillStyle = primary;
        sample.forEach((v, i) => {
          ctx.globalAlpha = 0.45 + (v / h) * 0.55;
          ctx.fillRect(i * 3.5, h - v, 2.4, v);
        });
        ctx.globalAlpha = 1;

        if (g.ObsidianDS) g.ObsidianDS.rollSpectrogram(this.matrix, sample, 35);
        
        /* 3D Visualizer for Now Playing Modal */
        const nowC = document.getElementById('now-visualizer');
        if (nowC) {
          if (nowC.width !== nowC.offsetWidth * 2) {
            nowC.width = nowC.offsetWidth * 2;
            nowC.height = nowC.offsetHeight * 2;
          }
          const nCtx = nowC.getContext('2d');
          const nw = nowC.width, nh = nowC.height;
          nCtx.clearRect(0, 0, nw, nh);
          
          if (data) {
            const cx = nw / 2;
            const cy = nh / 2;
            const radius = Math.min(nw, nh) * 0.18;
            const bins = 64;
            const step = Math.floor(data.length / bins);
            const tilt = 0.6; // Isometric tilt
            
            nCtx.strokeStyle = primary;
            nCtx.lineWidth = 4;
            nCtx.lineCap = 'round';
            
            for (let i = 0; i < bins; i++) {
              const angle = (i / bins) * Math.PI * 2 - Math.PI / 2;
              const val = data[i * step] / 255;
              const barLen = val * (radius * 1.5);
              
              const cosA = Math.cos(angle);
              const sinA = Math.sin(angle);
              
              const bx = cx + cosA * radius;
              const by = cy + sinA * radius * tilt;
              
              // Extrude UP (-Y) in isometric space
              const tx = bx + cosA * barLen * 0.1;
              const ty = by - barLen * tilt - sinA * barLen * 0.1;
              
              nCtx.beginPath();
              nCtx.moveTo(bx, by);
              nCtx.lineTo(tx, ty);
              nCtx.globalAlpha = 0.2 + val * 0.8;
              nCtx.stroke();
              
              // Glowing particle at the tip
              nCtx.fillStyle = '#fff';
              nCtx.globalAlpha = val;
              nCtx.beginPath();
              nCtx.arc(tx, ty, 2 + val * 4, 0, Math.PI * 2);
              nCtx.fill();
            }
            nCtx.globalAlpha = 1;
          }
        }

        requestAnimationFrame(tick);
      };
      tick();
    }

    /** Return the node bundle for whichever element is currently playing. */
    _activeNodes() {
      if (this.remote && !this.remote.paused && this.nodes.has(this.remote))
        return this.nodes.get(this.remote);
      if (this.local && !this.local.paused && this.nodes.has(this.local))
        return this.nodes.get(this.local);
      return null;
    }
  }

  g.ObsidianSound = SoundEngine;
})(window);
