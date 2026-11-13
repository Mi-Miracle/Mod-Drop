// Спільний рендер картки: оверлей OBS + передпоказ у панелі.
(function () {
  const TAGS = { image: 'картинка', gif: 'гіфка', video: 'відео', audio: 'аудіо', text: 'повідомлення', article: 'стаття' };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const host = () => location.hostname || 'localhost';

  let ytPromise = null;
  function loadYT() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytPromise) return ytPromise;
    ytPromise = new Promise(resolve => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(window.YT); };
      const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
    });
    return ytPromise;
  }

  function hms(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + 'h' : '') + (m ? m + 'm' : '') + s + 's';
  }

  // URL iframe для сервісів без JS API
  function embedSrc(e, item, preview) {
    const muted = preview || item.muted;
    const p = encodeURIComponent(host());
    switch (e.kind) {
      case 'youtube': return `https://www.youtube.com/embed/${e.id}?autoplay=1&mute=${muted ? 1 : 0}&start=${e.start || 0}&controls=${preview ? 1 : 0}&rel=0&modestbranding=1&playsinline=1`;
      case 'twitchclip': return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(e.id)}&parent=${p}&autoplay=true&muted=${muted}`;
      case 'twitchvod': return `https://player.twitch.tv/?video=${e.id}&parent=${p}&autoplay=true&muted=${muted}&time=${hms(e.start)}`;
      case 'vimeo': return `https://player.vimeo.com/video/${e.id}?autoplay=1&muted=${muted ? 1 : 0}&title=0&byline=0&portrait=0#t=${e.start || 0}s`;
      case 'streamable': return `https://streamable.com/e/${e.id}?autoplay=1&muted=${muted ? 1 : 0}&nocontrols=1`;
      case 'tiktok': return `https://www.tiktok.com/player/v1/${e.id}?autoplay=1&mute=${muted ? 1 : 0}&controls=0&description=0&music_info=0&rel=0`;
    }
    return 'about:blank';
  }

  // напрямок і точка старту ефекту залежать від позиції картки
  const DIR = {
    left: ['-115%', '0'], tl: ['-115%', '0'], bl: ['-115%', '0'],
    right: ['115%', '0'], tr: ['115%', '0'], br: ['115%', '0'],
    top: ['0', '-115%'], bottom: ['0', '115%'], center: ['0', '80px'],
  };
  const ORIGIN = { tl: ['0%', '0%'], tr: ['100%', '0%'], bl: ['0%', '100%'], br: ['100%', '100%'], left: ['0%', '50%'], right: ['100%', '50%'], top: ['50%', '0%'], bottom: ['50%', '100%'], center: ['50%', '50%'] };
  const FX = ['slide', 'pop', 'flip', 'zoom', 'reveal', 'glitch', 'none'];
  function applyFx(card, fx, pos) {
    let f = FX.includes(fx) ? fx : 'auto';
    if (f === 'auto') f = pos === 'center' ? 'pop' : 'slide';
    card.classList.add('fx-' + f);
    const d = DIR[pos] || DIR.center, o = ORIGIN[pos] || ORIGIN.center;
    card.style.setProperty('--fx-x', d[0]); card.style.setProperty('--fx-y', d[1]);
    card.style.setProperty('--fx-ox', o[0]); card.style.setProperty('--fx-oy', o[1]);
  }

  function render(item, stage, opts = {}) {
    const preview = !!opts.preview;
    const cleanups = [];
    let ended = false;
    const fireEnded = () => { if (!ended && !preview) { ended = true; opts.onEnded && opts.onEnded(item); } };

    const pos = item.pos && item.pos !== 'auto' ? item.pos : (item.type === 'audio' ? 'br' : (opts.defaultPos || 'center'));
    stage.className = 'md-stage pos-' + pos;
    const olds = [...stage.children];
    // передпоказ: якщо змінився лише текст/оформлення — переносимо вже завантажений плеєр, а не створюємо новий
    const mk = mediaKeyOf(item);
    const reuse = preview && opts.reuse && mk && opts.reuse.mediaKey === mk && opts.reuse.mediaNode ? opts.reuse : null;
    let mediaNode = null, placeholder = null;
    const slot = parent => { placeholder = el('div'); parent.appendChild(placeholder); };

    const card = el('div', `md-card size-${item.size || 'm'} t-${item.type}`);
    if (opts.cardScale) card.style.setProperty('--card-scale', opts.cardScale);
    applyFx(card, item.fx, pos);

    const head = el('div', 'md-head');
    if (item.by && item.by.avatar) { const a = el('img'); a.src = item.by.avatar; a.onerror = () => a.remove(); head.appendChild(a); }
    head.appendChild(el('span', null, 'від'));
    head.appendChild(el('span', 'who', (item.by && (item.by.name || item.by.login)) || 'модер'));
    head.appendChild(el('span', 'tag', TAGS[item.type] || ''));
    card.appendChild(head);

    const body = el('div', 'md-body');
    card.appendChild(body);
    const vol = item.volume == null ? 1 : item.volume / 100;

    // ── картинка ──
    if (item.type === 'image' || item.type === 'gif') {
      const img = el('img', 'md-media'); img.src = item.src; img.alt = ''; body.appendChild(img);
    }

    // ── відео ──
    else if (item.type === 'video' && item.embed && reuse) slot(body);
    else if (item.type === 'video' && item.embed) {
      const e = item.embed;
      const box = el('div', 'md-embed' + (e.kind === 'tiktok' ? ' vertical' : ''));
      body.appendChild(box); mediaNode = box;
      if (e.kind === 'youtube' && !preview) {
        const inner = el('div'); box.appendChild(inner);
        loadYT().then(YT => {
          if (!inner.isConnected) return;
          const pl = new YT.Player(inner, {
            width: '100%', height: '100%', videoId: e.id,
            playerVars: { autoplay: 1, start: e.start || 0, controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
            events: {
              onReady: ev => { if (item.muted) ev.target.mute(); else ev.target.setVolume(Math.round(vol * 100)); ev.target.playVideo(); },
              onStateChange: ev => { if (ev.data === YT.PlayerState.ENDED) fireEnded(); },
              onError: () => fireEnded(),
            },
          });
          cleanups.push(() => { try { pl.destroy(); } catch {} });
        });
      } else {
        const f = el('iframe'); f.allow = 'autoplay; encrypted-media; fullscreen'; f.src = embedSrc(e, item, preview);
        box.appendChild(f);
      }
    }
    else if (item.type === 'video' && reuse) slot(body);
    else if (item.type === 'video') {
      const v = el('video', 'md-media'); mediaNode = v;
      v.playsInline = true; v.autoplay = true; v.src = item.src;
      v.volume = vol; v.muted = preview || !!item.muted;
      if (preview) { v.loop = true; v.controls = true; }
      v.addEventListener('loadedmetadata', () => { if (item.start) v.currentTime = Math.min(item.start, v.duration || item.start); });
      v.addEventListener('ended', fireEnded);
      v.addEventListener('error', fireEnded);
      body.appendChild(v);
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      cleanups.push(() => { v.pause(); v.removeAttribute('src'); v.load(); });
    }

    // ── аудіо ──
    else if (item.type === 'audio') {
      const wrap = el('div', 'md-audio' + (preview ? ' paused' : ''));
      const disc = el('div', 'disc');
      if (item.embed && item.embed.kind === 'youtube') disc.style.backgroundImage = `url(https://i.ytimg.com/vi/${item.embed.id}/hqdefault.jpg)`;
      wrap.appendChild(disc);
      const meta = el('div', 'meta');
      meta.appendChild(el('div', 'eyebrow', 'Зараз грає'));
      meta.appendChild(el('div', 'atitle', item.title || 'Аудіо'));
      if (item.artist) meta.appendChild(el('div', 'artist', item.artist));
      const eq = el('div', 'eq'); for (let i = 0; i < 14; i++) { const b = el('i'); b.style.animationDelay = (-i * 0.13) + 's'; eq.appendChild(b); } meta.appendChild(eq);
      const tbar = el('div', 'time'); const tfill = el('b'); tbar.appendChild(tfill); meta.appendChild(tbar);
      wrap.appendChild(meta);
      body.appendChild(wrap);
      const setPlaying = on => wrap.classList.toggle('paused', !on);

      if (item.embed && item.embed.kind === 'youtube') {
        if (preview && reuse) slot(meta);
        else if (preview) {
          const f = el('iframe'); f.allow = 'autoplay'; mediaNode = f; f.style.cssText = 'width:100%;height:120px;border:0;margin-top:14px;border-radius:10px';
          f.src = `https://www.youtube.com/embed/${item.embed.id}?start=${item.embed.start || 0}&controls=1&rel=0`;
          meta.appendChild(f);
        } else {
          const hidden = el('div', 'md-hidden-player'); const inner = el('div'); hidden.appendChild(inner); card.appendChild(hidden);
          loadYT().then(YT => {
            if (!inner.isConnected) return;
            let iv;
            const pl = new YT.Player(inner, {
              width: 200, height: 200, videoId: item.embed.id,
              playerVars: { autoplay: 1, start: item.embed.start || 0, controls: 0 },
              events: {
                onReady: ev => { if (item.muted) ev.target.mute(); else ev.target.setVolume(Math.round(vol * 100)); ev.target.playVideo(); },
                onStateChange: ev => {
                  setPlaying(ev.data === YT.PlayerState.PLAYING);
                  if (ev.data === YT.PlayerState.ENDED) fireEnded();
                },
                onError: () => fireEnded(),
              },
            });
            iv = setInterval(() => { try { const d = pl.getDuration(); if (d) tfill.style.transform = `scaleX(${pl.getCurrentTime() / d})`; } catch {} }, 500);
            cleanups.push(() => { clearInterval(iv); try { pl.destroy(); } catch {} });
          });
        }
      } else if (preview && reuse) slot(meta);
      else {
        const a = el('audio'); a.src = item.src; if (preview) mediaNode = a; a.volume = vol; a.muted = !!item.muted && !preview;
        a.addEventListener('loadedmetadata', () => { if (item.start) a.currentTime = Math.min(item.start, a.duration || item.start); });
        a.addEventListener('timeupdate', () => { if (a.duration) tfill.style.transform = `scaleX(${a.currentTime / a.duration})`; });
        a.addEventListener('play', () => setPlaying(true));
        a.addEventListener('pause', () => setPlaying(false));
        a.addEventListener('ended', () => { setPlaying(false); fireEnded(); });
        a.addEventListener('error', fireEnded);
        if (preview) { a.controls = true; meta.appendChild(a); }
        else { a.autoplay = true; card.appendChild(a); a.play().catch(() => {}); }
        cleanups.push(() => { a.pause(); a.removeAttribute('src'); a.load(); });
      }
    }

    // ── текст ──
    else if (item.type === 'text') {
      const t = el('div', 'md-text');
      if (item.title) t.appendChild(el('h2', null, item.title));
      t.appendChild(document.createTextNode(item.text || ''));
      body.appendChild(t);
      requestAnimationFrame(() => {
        if (!t.isConnected) return;
        const cs = getComputedStyle(card);
        let fs = parseFloat(cs.getPropertyValue('--fs')) || 38;
        const limit = parseFloat(cs.maxHeight) - 140;
        let guard = 12;
        while (t.scrollHeight > limit && fs > 16 && guard--) { fs = Math.max(16, Math.floor(fs * .85)); t.style.fontSize = fs + 'px'; }
      });
    }

    // ── стаття ──
    else if (item.type === 'article') {
      const a = el('div', 'md-article');
      if (item.image) { const c = el('img', 'cover'); c.src = item.image; c.onerror = () => c.remove(); a.appendChild(c); }
      const info = el('div', 'info');
      info.appendChild(el('div', 'site', '🔗 ' + (item.site || '')));
      info.appendChild(el('div', 'title', item.title || item.url || ''));
      if (item.description) info.appendChild(el('div', 'desc', item.description));
      a.appendChild(info);
      body.appendChild(a);
    }

    if (item.note) card.appendChild(el('div', 'md-note', item.note));

    if (item.duration > 0) {
      const bar = el('div', 'md-bar');
      const total = item.duration * 1000;
      const left = preview ? total : Math.max(0, total - (Date.now() - (item.shownAt || Date.now())));
      bar.animate([{ transform: `scaleX(${left / total})` }, { transform: 'scaleX(0)' }],
        { duration: left, easing: 'linear', fill: 'forwards', iterations: preview ? Infinity : 1 });
      card.appendChild(bar);
    }

    stage.appendChild(card);
    if (reuse && placeholder) {
      const node = reuse.mediaNode;
      // moveBefore зберігає стан iframe/відео (Chrome 133+); інакше — звичайне перенесення
      if (placeholder.parentNode.moveBefore) { try { placeholder.parentNode.moveBefore(node, placeholder); } catch { placeholder.parentNode.insertBefore(node, placeholder); } }
      else placeholder.parentNode.insertBefore(node, placeholder);
      placeholder.remove();
      mediaNode = node;
      if (node.tagName === 'VIDEO' && node.paused) node.play().catch(() => {});
      cleanups.push(...reuse._cleanups); reuse._cleanups.length = 0;
    } else if (opts.reuse && opts.reuse !== reuse) opts.reuse.destroy();
    olds.forEach(o => o.remove());
    return {
      el: card, mediaKey: mk, mediaNode, _cleanups: cleanups,
      destroy(animated) {
        cleanups.forEach(f => { try { f(); } catch {} });
        if (animated) { card.classList.add('out'); setTimeout(() => card.remove(), 500); }
        else card.remove();
      },
    };
  }

  function mediaKeyOf(item) {
    if (item.type === 'video') return JSON.stringify(['v', item.src || '', item.embed || '', item.start || 0, !!item.muted]);
    if (item.type === 'audio') return JSON.stringify(['a', item.src || '', item.embed || '', item.start || 0]);
    return '';
  }

  // ═════ Звук сповіщення (синтез WebAudio — без файлів) ═════
  let actx = null;
  function ctx() {
    if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; actx = new C(); }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  function tone(c, out, { f, t = 0, d = .6, type = 'sine', g = .5, slide = 0 }) {
    const o = c.createOscillator(), a = c.createGain(), now = c.currentTime + t;
    o.type = type; o.frequency.setValueAtTime(f, now);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f * slide), now + d);
    a.gain.setValueAtTime(0, now); a.gain.linearRampToValueAtTime(g, now + .008); a.gain.exponentialRampToValueAtTime(.0001, now + d);
    o.connect(a); a.connect(out); o.start(now); o.stop(now + d + .05);
  }
  const SOUNDS = {
    chime: (c, o) => { tone(c, o, { f: 1318.5, d: .9, g: .45 }); tone(c, o, { f: 1975.5, t: .12, d: 1.1, g: .35 }); tone(c, o, { f: 2637, t: .12, d: .6, g: .08 }); },
    ping:  (c, o) => { tone(c, o, { f: 1760, d: .5, type: 'triangle', g: .55 }); tone(c, o, { f: 3520, d: .25, g: .08 }); },
    pop:   (c, o) => { tone(c, o, { f: 900, d: .18, g: .6, slide: .35 }); tone(c, o, { f: 1400, t: .1, d: .16, g: .45, slide: .4 }); },
    harp:  (c, o) => { [523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, i) => tone(c, o, { f, t: i * .07, d: 1.2, type: 'triangle', g: .3 })); },
    bell:  (c, o) => { [[880, .5], [1760 * 1.003, .22], [2640 * .997, .12], [3520, .06]].forEach(([f, g]) => tone(c, o, { f, d: 1.8, g })); },
    alert: (c, o) => { [0, .16, .32].forEach(t => tone(c, o, { f: 1046.5, t, d: .14, type: 'square', g: .12 })); tone(c, o, { f: 1568, t: .48, d: .5, type: 'triangle', g: .35 }); },
  };
  function chime(name, volume) {
    const c = ctx(); if (!c || !SOUNDS[name]) return false;
    const out = c.createGain(); out.gain.value = Math.max(0, Math.min(1, (volume == null ? 70 : volume) / 100));
    out.connect(c.destination);
    SOUNDS[name](c, out);
    return c.state === 'running';
  }

  window.MDRender = { render, TAGS, chime, unlockAudio: ctx, SOUND_NAMES: Object.keys(SOUNDS) };
})();
