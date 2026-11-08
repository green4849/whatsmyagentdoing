// Document PiP uses a separate page so its animation clock keeps running when
// the opener tab is hidden (the iframe approach from wanting82's PR #3).
// Older browsers can use their video PiP controls on a local canvas stream.
(() => {
  'use strict';

  class OfficePopout {
    constructor({ preferences, office, strip, text, changed }) {
      this.preferences = preferences;
      this.office = office;
      // () => { rows, counts, quiet }: the numbered list drawn under the room in the video.
      this.strip = strip || (() => null);
      this.text = text;
      this.changed = changed;
      this.win = null;
      this.busy = false;
      this.stream = null;
      this.panel = document.getElementById('pipPreview');
      this.video = document.getElementById('pipVideo');
      this.error = document.getElementById('pipError');
      this.videoButton = document.getElementById('videoPipBtn');
      document.getElementById('pipBtn').addEventListener('click', () => this.toggle());
      document.getElementById('closePreview').addEventListener('click', () => this.stopPreview());
      this.videoButton.addEventListener('click', () => this.openVideo().catch(() => this.fail()));
      this.video.addEventListener('leavepictureinpicture', () => this.stopPreview());
      window.addEventListener('pagehide', () => this.close());
    }

    get documentSupported() {
      return !this.documentBroken && window.top === window && typeof window.documentPictureInPicture?.requestWindow === 'function';
    }

    get videoSupported() {
      return typeof HTMLCanvasElement.prototype.captureStream === 'function';
    }

    sync(compact, view) {
      const button = document.getElementById('pipBtn');
      button.hidden = compact || !(this.documentSupported || (this.videoSupported && view === 'office'));
      button.disabled = this.busy;
      button.textContent = this.win ? this.text('pipClose') : this.stream ? this.text('pipStop') : this.text('pip');
      button.setAttribute('aria-pressed', String(!!(this.win || this.stream)));
      this.videoButton.hidden = !this.canOpenVideo();
      if (this.error.textContent) this.error.textContent = this.text('pipFailed');
      if (view !== 'office' && this.stream) this.stopPreview();
    }

    fail() {
      this.error.textContent = this.text('pipFailed');
      this.error.hidden = false;
    }

    async toggle() {
      if (this.busy) return;
      this.error.textContent = '';
      this.error.hidden = true;
      if (this.win) { this.close(); return; }
      if (this.stream) { this.stopPreview(); return; }
      this.busy = true;
      this.changed();
      try {
        if (this.documentSupported) {
          try {
            await this.openDocument();
          } catch (e) {
            // Some embedded browsers (app web views) expose the API but can't
            // open a window ("no window"). Use the video pop-out there instead,
            // and skip the window from now on.
            if (e.name !== 'InvalidStateError' || !this.videoSupported) throw e;
            this.documentBroken = true;
            await this.startPreview();
          }
        } else await this.startPreview();
      } catch (e) {
        console.warn('Could not open picture-in-picture:', e);
        this.close();
        if (e.name !== 'AbortError') this.fail();
      } finally {
        this.busy = false;
        this.changed();
      }
    }

    async openDocument() {
      const win = await window.documentPictureInPicture.requestWindow({ width: 480, height: 400 });
      if (win.closed) return;
      this.win = win;
      win.addEventListener('pagehide', () => {
        if (this.win !== win) return;
        this.win = null;
        this.changed();
      }, { once: true });
      const d = win.document;
      d.title = this.text('title');
      const style = d.createElement('style');
      style.textContent = 'html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';
      d.head.append(style);
      const frame = d.createElement('iframe');
      frame.title = this.text('title');
      const url = new URL('/', location.href);
      url.searchParams.set('pip', '1');
      for (const k of ['account', 'folder', 'agent']) {
        const v = new URLSearchParams(location.search).get(k);
        if (v) url.searchParams.set(k, v);
      }
      // Carry the current settings even if storage is unavailable. The page
      // validates these preferences before using them.
      url.searchParams.set('prefs', JSON.stringify(this.preferences()));
      frame.src = url.href;
      d.body.append(frame);
    }

    canOpenVideo() {
      return (document.pictureInPictureEnabled && typeof this.video.requestPictureInPicture === 'function') ||
        (typeof this.video.webkitSupportsPresentationMode === 'function' && this.video.webkitSupportsPresentationMode('picture-in-picture'));
    }

    async openVideo() {
      if (document.pictureInPictureEnabled && this.video.requestPictureInPicture) {
        await this.video.requestPictureInPicture();
      } else if (this.video.webkitSetPresentationMode) {
        this.video.webkitSetPresentationMode('picture-in-picture');
      }
    }

    async startPreview() {
      this.captureCanvas = document.createElement('canvas');
      this.captureCanvas.width = 960;
      this.captureCanvas.height = 540;
      this.captureContext = this.captureCanvas.getContext('2d');
      this.stream = this.captureCanvas.captureStream(15);
      this.video.srcObject = this.stream;
      this.panel.hidden = false;
      // A background tab can stop requestAnimationFrame. Keep the preview
      // current at a lower rate; browsers may throttle this timer further.
      this.timer = setInterval(() => {
        if (document.hidden) this.office()?.frame(performance.now());
      }, 250);
      this.office()?.frame(performance.now());
      await this.video.play();
      if (!this.stream) return;
      if (this.canOpenVideo()) {
        // If transient activation expired, the preview has a fresh-click
        // button. Firefox versions without the API expose their own controls.
        try { await this.openVideo(); } catch { /* use the preview controls */ }
      }
    }

    drawPreview(office) {
      if (!this.stream || !office.canvas.width || !office.canvas.height) return;
      // Send only the room: in 2D its own box, in 3D the area left of the side
      // panel. The video takes the room's shape (a video can't be transparent),
      // with a short numbered list of who needs you and who works under it.
      const room = !office.gl && office.roomRect?.();
      const r = room || { x: 0, y: 0, w: Math.max(40, office.cw - (office.inset?.() || 0)), h: office.ch };
      const info = this.strip();
      const MAX_ROWS = 5, ROW = 34, PAD = 12;
      const rows = info ? info.rows.slice(0, MAX_ROWS) : [];
      const stripH = info ? PAD * 2 + ROW * (1 + Math.max(1, rows.length) + (info.rows.length > MAX_ROWS ? 1 : 0)) : 0;
      const w = 960;
      let roomW = w, roomH = Math.round(w * r.h / r.w);
      if (roomH + stripH > 720) { roomH = Math.max(160, 720 - stripH); roomW = Math.round(roomH * r.w / r.h); }
      const h = roomH + stripH;
      const cv = this.captureCanvas;
      if (Math.abs(cv.width - w) > 8 || Math.abs(cv.height - h) > 8) { cv.width = w; cv.height = h; }
      const c = this.captureContext;
      const dark = office.pal.dark;
      c.fillStyle = dark ? '#2b2926' : '#fbf8f2';
      c.fillRect(0, 0, cv.width, cv.height);
      const dx = Math.round((cv.width - roomW) / 2);
      // Each canvas has its own pixel ratio (3D may draw at 1x with power saving).
      const copy = (src) => {
        const k = src.width / office.cw;
        c.drawImage(src, r.x * k, r.y * k, r.w * k, r.h * k, dx, 0, roomW, roomH);
      };
      if (office.gl) copy(office.gl.domElement);
      copy(office.canvas);
      if (info) this.drawStrip(c, info, rows, roomH, cv.width, stripH, { ROW, PAD, MAX_ROWS, dark });
    }

    drawStrip(c, info, rows, top, width, height, { ROW, PAD, MAX_ROWS, dark }) {
      const ink = dark ? '#ecebe6' : '#1c1c1a', muted = dark ? '#a3a19a' : '#6b6a64';
      c.fillStyle = dark ? '#1f1d1b' : '#ffffff';
      c.fillRect(0, top, width, height);
      c.fillStyle = dark ? '#3a3733' : '#e6e1d6';
      c.fillRect(0, top, width, 1);
      c.textBaseline = 'middle';
      const font = (wt, px) => `${wt} ${px}px ui-sans-serif, system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`;
      // Fit text into a width, cutting with an ellipsis.
      const fit = (t, max) => {
        t = String(t || '');
        if (c.measureText(t).width <= max) return t;
        while (t.length > 1 && c.measureText(t + '…').width > max) t = t.slice(0, -1);
        return t + '…';
      };
      let y = top + PAD + ROW / 2;
      // Counts: ● Needs you 0   ● Working 2   ● Finished 7
      let x = PAD + 4;
      c.font = font(600, 17);
      for (const [label, n, color] of info.counts) {
        c.fillStyle = color; c.beginPath(); c.arc(x + 5, y, 5, 0, Math.PI * 2); c.fill();
        c.fillStyle = muted; c.fillText(label, x + 16, y);
        const lw = c.measureText(label).width;
        c.fillStyle = ink; c.font = font(700, 17); c.fillText(String(n), x + 22 + lw, y);
        x += 22 + lw + c.measureText(String(n)).width + 26;
        c.font = font(600, 17);
      }
      y += ROW;
      if (!rows.length) {
        c.font = font(500, 17); c.fillStyle = muted;
        c.fillText(fit(info.quiet, width - PAD * 2), PAD + 4, y);
        return;
      }
      for (const row of rows) {
        let x = PAD + 4;
        c.font = font(700, 20); c.fillStyle = row.color;
        c.fillText(row.badge || '•', x, y);
        x += 30;
        c.font = font(700, 18); c.fillStyle = ink;
        const name = fit(row.name, width * 0.36);
        c.fillText(name, x, y);
        x += c.measureText(name).width + 12;
        c.font = font(600, 16); c.fillStyle = row.color;
        c.fillText(row.status, x, y);
        x += c.measureText(row.status).width + 12;
        const rest = [row.act, row.name !== row.folder ? row.folder : ''].filter(Boolean).join(' · ');
        if (rest && x < width - PAD - 40) {
          c.font = font(500, 16); c.fillStyle = muted;
          c.fillText(fit(rest, width - PAD - x), x, y);
        }
        y += ROW;
      }
      if (info.rows.length > MAX_ROWS) {
        c.font = font(500, 16); c.fillStyle = muted;
        c.fillText(`+${info.rows.length - MAX_ROWS}`, PAD + 4, y);
      }
    }

    stopPreview() {
      if (!this.stream) return;
      if (document.pictureInPictureElement === this.video) document.exitPictureInPicture().catch(() => {});
      if (this.video.webkitPresentationMode === 'picture-in-picture') this.video.webkitSetPresentationMode('inline');
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      clearInterval(this.timer);
      this.video.pause();
      this.video.srcObject = null;
      this.captureCanvas = this.captureContext = null;
      this.panel.hidden = true;
      this.changed();
    }

    close() {
      const win = this.win;
      this.win = null;
      if (win && !win.closed) win.close();
      this.stopPreview();
      this.changed();
    }
  }

  window.OfficePopout = OfficePopout;
})();
