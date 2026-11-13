// Пошук з кількох джерел одразу: Bing + DuckDuckGo (картинки, GIF), GIPHY, YouTube, кліпи Twitch-каналу.
const { safeHttpUrl, clamp } = require('./media');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.6' };
const T = ms => AbortSignal.timeout(ms);

// GIF має реально бути анімованим, тож беремо тільки посилання на .gif/.webp або з GIF-хостингів
const isAnimUrl = u => /\.gif(\?|$)/i.test(u) || /(giphy\.com|tenor\.com|gfycat\.com|imgur\.com\/.+\.(gifv?|mp4))/i.test(u) || /\.webp(\?|$)/i.test(u);

// ── Bing ──
async function bing(q, p, animated) {
  const u = new URL('https://www.bing.com/images/async');
  u.searchParams.set('q', q); u.searchParams.set('first', String(1 + p * 35)); u.searchParams.set('count', '35');
  u.searchParams.set('mmasync', '1'); u.searchParams.set('adlt', 'moderate');
  u.searchParams.set('setlang', 'uk-UA'); u.searchParams.set('cc', 'UA'); u.searchParams.set('mkt', 'uk-UA');
  if (animated) u.searchParams.set('qft', '+filterui:photo-animatedgif');
  const r = await fetch(u, { headers: H, signal: T(9000) });
  if (!r.ok) throw new Error('bing ' + r.status);
  const html = await r.text();
  const out = [];
  for (const m of html.matchAll(/\sm="(\{[^"]+\})"/g)) {
    try {
      const j = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const url = safeHttpUrl(j.murl);
      if (!url || !url.startsWith('https:')) continue;
      if (animated && !isAnimUrl(url)) continue;
      out.push({ url, thumb: animated ? url : (safeHttpUrl(j.turl) || url), still: safeHttpUrl(j.turl) || '', title: clamp(j.t, 120), page: safeHttpUrl(j.purl) || '', src: 'Bing' });
    } catch {}
  }
  return out;
}

// ── DuckDuckGo (без ключа) ──
const vqdCache = new Map();
async function ddgVqd(q) {
  if (vqdCache.has(q)) return vqdCache.get(q);
  const r = await fetch('https://duckduckgo.com/?' + new URLSearchParams({ q, iax: 'images', ia: 'images' }), { headers: H, signal: T(8000) });
  const html = await r.text();
  const m = html.match(/vqd=["']?([\d-]+)["']?/) || html.match(/vqd%3D([\d-]+)/);
  if (!m) throw new Error('ddg: no vqd');
  vqdCache.set(q, m[1]);
  if (vqdCache.size > 200) vqdCache.delete(vqdCache.keys().next().value);
  return m[1];
}
async function ddg(q, p, animated) {
  const vqd = await ddgVqd(q);
  const u = new URL('https://duckduckgo.com/i.js');
  u.searchParams.set('l', 'ua-uk'); u.searchParams.set('o', 'json'); u.searchParams.set('q', q); u.searchParams.set('vqd', vqd);
  u.searchParams.set('f', animated ? ',,,type:gif,,' : ',,,,,'); u.searchParams.set('p', '1');
  if (p) u.searchParams.set('s', String(p * 100));
  const r = await fetch(u, { headers: { ...H, Referer: 'https://duckduckgo.com/', Accept: 'application/json' }, signal: T(9000) });
  if (!r.ok) throw new Error('ddg ' + r.status);
  const j = await r.json();
  return (j.results || []).map(x => {
    const url = safeHttpUrl(x.image);
    if (!url || !url.startsWith('https:')) return null;
    if (animated && !isAnimUrl(url)) return null;
    return { url, thumb: animated ? url : (safeHttpUrl(x.thumbnail) || url), still: safeHttpUrl(x.thumbnail) || '', title: clamp(x.title, 120), page: safeHttpUrl(x.url) || '', src: 'DuckDuckGo' };
  }).filter(Boolean);
}

// ── GIPHY ──
async function giphy(q, p, key) {
  const u = new URL(q ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending');
  u.searchParams.set('api_key', key); u.searchParams.set('limit', '40'); u.searchParams.set('offset', String(p * 40));
  u.searchParams.set('rating', 'pg-13'); u.searchParams.set('country_code', 'UA');
  if (q) { u.searchParams.set('q', q); u.searchParams.set('lang', 'uk'); }
  const r = await fetch(u, { signal: T(8000) });
  if (!r.ok) throw new Error('giphy ' + r.status);
  const j = await r.json();
  return j.data.map(g => ({
    url: g.images.original.url.split('?')[0],
    thumb: (g.images.fixed_width_downsampled || g.images.fixed_width || g.images.original).url,
    still: (g.images.fixed_width_still || {}).url || '',
    title: g.title || '', user: (g.user && g.user.display_name) || g.username || '', src: 'GIPHY',
  })).filter(x => x.url);
}

// ── YouTube (без ключа, з підвантаженням наступних сторінок) ──
const ytState = new Map(); // q → { key, ver, tokens: [] }
const runs = x => (x && (x.simpleText || (x.runs || []).map(r => r.text).join(''))) || '';
function collectVideos(obj, out, tokenBox) {
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      out.push({
        url: 'https://www.youtube.com/watch?v=' + v.videoId, id: v.videoId,
        thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        title: clamp(runs(v.title), 140), channel: clamp(runs(v.ownerText), 80), duration: runs(v.lengthText), src: 'YouTube',
      });
      return;
    }
    if (o.continuationCommand && o.continuationCommand.token) tokenBox.token = o.continuationCommand.token;
    for (const k in o) walk(o[k]);
  })(obj);
}
async function youtube(q, p) {
  let st = ytState.get(q);
  if (p === 0 || !st) {
    const u = new URL('https://www.youtube.com/results');
    u.searchParams.set('search_query', q); u.searchParams.set('hl', 'uk'); u.searchParams.set('gl', 'UA');
    const r = await fetch(u, { headers: { ...H, Cookie: 'CONSENT=YES+1; SOCS=CAI; PREF=hl=uk&gl=UA' }, signal: T(9000) });
    if (!r.ok) throw new Error('yt ' + r.status);
    const html = await r.text();
    const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.+?\});/s);
    if (!m) throw new Error('yt: no data');
    const out = [], box = {};
    collectVideos(JSON.parse(m[1]), out, box);
    st = {
      key: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1],
      ver: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '2.20241101.00.00',
      tokens: [box.token],
    };
    ytState.set(q, st);
    if (ytState.size > 100) ytState.delete(ytState.keys().next().value);
    if (p === 0) return out;
  }
  const token = st.tokens[p - 1];
  if (!token || !st.key) return [];
  const r = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${st.key}&prettyPrint=false`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, signal: T(9000),
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: st.ver, hl: 'uk', gl: 'UA' } }, continuation: token }),
  });
  if (!r.ok) throw new Error('yt cont ' + r.status);
  const out = [], box = {};
  collectVideos(await r.json(), out, box);
  st.tokens[p] = box.token;
  return out;
}

// ── YouTube Music (пісні) ──
const ytmState = new Map(); // q → tokens[]
const YTM_SONGS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
function collectSongs(obj, out, box) {
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    const r = o.musicResponsiveListItemRenderer;
    if (r) {
      const id = (r.playlistItemData && r.playlistItemData.videoId) ||
        (((r.overlay || {}).musicItemThumbnailOverlayRenderer || {}).content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId);
      if (id) {
        const col = i => ((r.flexColumns || [])[i] || {}).musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const title = col(0).map(x => x.text).join('');
        const meta = col(1).map(x => x.text).join('').split(' • ').map(x => x.trim()).filter(Boolean);
        const dur = meta.find(x => /^\d+:\d{2}(:\d{2})?$/.test(x)) || '';
        const artist = meta.filter(x => x !== dur && !/^(Пісня|Song|Відео|Video)$/i.test(x))[0] || '';
        const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        out.push({
          url: 'https://music.youtube.com/watch?v=' + id, id,
          thumb: (thumbs[thumbs.length - 1] || {}).url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          title: clamp(title, 140), artist: clamp(artist, 100), channel: clamp(artist, 100), duration: dur, src: 'YouTube Music',
        });
      }
      return;
    }
    if (o.nextContinuationData && o.nextContinuationData.continuation) box.token = o.nextContinuationData.continuation;
    if (o.continuationCommand && o.continuationCommand.token) box.cmd = o.continuationCommand.token;
    for (const k in o) walk(o[k]);
  })(obj);
}
async function ytmusic(q, p) {
  const ctx = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20241106.01.00', hl: 'uk', gl: 'UA' } };
  let url = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
  let body = { context: ctx, query: q, params: YTM_SONGS };
  if (p > 0) {
    const st = ytmState.get(q);
    const t = st && st[p - 1];
    if (!t) return [];
    if (t.token) { url += `&ctoken=${encodeURIComponent(t.token)}&continuation=${encodeURIComponent(t.token)}&type=next`; body = { context: ctx }; }
    else body = { context: ctx, continuation: t.cmd };
  }
  const r = await fetch(url, {
    method: 'POST', signal: T(9000),
    headers: { ...H, 'Content-Type': 'application/json', Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/', 'X-Goog-Visitor-Id': '' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('ytm ' + r.status);
  const out = [], box = {};
  collectSongs(await r.json(), out, box);
  const st = ytmState.get(q) || [];
  st[p] = box.token || box.cmd ? box : null;
  ytmState.set(q, st);
  if (ytmState.size > 100) ytmState.delete(ytmState.keys().next().value);
  return out;
}

// ── Кліпи Twitch-каналу стрімера ──
let clipsCache = { t: 0, channel: '', list: [] };
let clipsLoading = null;
async function channelClips(channel, headers, twitchUsers) {
  if (clipsCache.channel === channel && Date.now() - clipsCache.t < 10 * 60 * 1000) return clipsCache.list;
  if (clipsLoading) return clipsLoading;
  clipsLoading = (async () => {
    const prof = (await twitchUsers([channel], headers))[channel];
    if (!prof) throw new Error('Канал не знайдено');
    const seen = new Map();
    const grab = async (from, to) => {
      let cursor = '';
      for (let i = 0; i < 10; i++) {   // до 1000 кліпів за період
        const u = new URL('https://api.twitch.tv/helix/clips');
        u.searchParams.set('broadcaster_id', prof.id); u.searchParams.set('first', '100');
        u.searchParams.set('started_at', from.toISOString()); u.searchParams.set('ended_at', to.toISOString());
        if (cursor) u.searchParams.set('after', cursor);
        const r = await fetch(u, { headers, signal: T(12000) });
        if (!r.ok) throw new Error('clips ' + r.status);
        const j = await r.json();
        for (const c of j.data) seen.set(c.id, c);
        cursor = j.pagination && j.pagination.cursor;
        if (!cursor || !j.data.length) break;
      }
    };
    // Twitch віддає кліпи лише за популярністю, тому проходимо всю історію каналу помісячно
    const created = new Date(prof.created_at || Date.now() - 5 * 365 * 864e5);
    const windows = [];
    let to = new Date();
    while (to > created && windows.length < 120) {
      const from = new Date(Math.max(created.getTime(), to.getTime() - 30 * 864e5));
      windows.push([from, to]); to = from;
    }
    for (let i = 0; i < windows.length; i += 6) await Promise.all(windows.slice(i, i + 6).map(([a, b]) => grab(a, b)));
    const list = [...seen.values()].map(c => ({
      url: 'https://clips.twitch.tv/' + c.id, id: c.id, thumb: c.thumbnail_url, title: clamp(c.title, 140),
      channel: '✂️ ' + c.creator_name + ' · 👁 ' + c.view_count + ' · ' + new Date(c.created_at).toLocaleDateString('uk-UA'),
      duration: Math.round(c.duration) + ' с', views: c.view_count, created: c.created_at, clipDuration: c.duration, creator: c.creator_name, src: 'Twitch',
    })).sort((a, b) => new Date(b.created) - new Date(a.created));
    clipsCache = { t: Date.now(), channel, list };
    return list;
  })();
  try { return await clipsLoading; } finally { clipsLoading = null; }
}
// усі кліпи одразу, спочатку новіші; пошук — за словами в назві або автором
function filterClips(list, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter(c => words.every(w => (c.title + ' ' + c.creator).toLowerCase().includes(w))) : list;
}

// змішує результати кількох джерел по черзі і прибирає дублікати
function interleave(lists) {
  const out = [], seen = new Set();
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) {
    const x = l[i]; if (!x) continue;
    const k = x.url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
    if (seen.has(k)) continue; seen.add(k); out.push(x);
  }
  return out;
}

module.exports = { bing, ddg, giphy, youtube, ytmusic, channelClips, filterClips, interleave, clipsCacheReset: () => { clipsCache = { t: 0, channel: '', list: [] }; } };
