// Розпізнавання посилань (YouTube, Twitch, Vimeo, Streamable, TikTok…) + прев'ю статей із захистом від SSRF.
const dns = require('dns').promises;
const net = require('net');

function safeHttpUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch { return null; }
}

function parseTime(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return +s;
  // 1h2m3s / 2m10s
  const hms = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  // 1:02:03 / 2:10
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((a, n) => a * 60 + +n, 0);
  return 0;
}

// Повертає { kind, id, start, label, endEvent } або null
function detectEmbed(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  const t = parseTime(u.searchParams.get('t') || u.searchParams.get('start'));

  let yt = null;
  if (host === 'youtu.be') yt = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') yt = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/); if (m) yt = m[2]; }
  }
  if (yt && /^[\w-]{6,20}$/.test(yt)) return { kind: 'youtube', id: yt, start: t, label: 'YouTube', endEvent: true };

  if (host === 'clips.twitch.tv') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (id && id !== 'embed') return { kind: 'twitchclip', id, label: 'Twitch-кліп' };
    if (u.searchParams.get('clip')) return { kind: 'twitchclip', id: u.searchParams.get('clip'), label: 'Twitch-кліп' };
  }
  if (host === 'twitch.tv') {
    let m = u.pathname.match(/^\/[^/]+\/clip\/([\w-]+)/);
    if (m) return { kind: 'twitchclip', id: m[1], label: 'Twitch-кліп' };
    m = u.pathname.match(/^\/videos\/(\d+)/);
    if (m) return { kind: 'twitchvod', id: m[1], start: t, label: 'Twitch VOD' };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d{5,})/);
    if (m) return { kind: 'vimeo', id: m[1], start: t, label: 'Vimeo' };
  }
  if (host === 'streamable.com') {
    const m = u.pathname.match(/^\/(?:e\/|o\/)?([a-z0-9]+)/i);
    if (m) return { kind: 'streamable', id: m[1], label: 'Streamable' };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const m = u.pathname.match(/\/video\/(\d+)/);
    if (m) return { kind: 'tiktok', id: m[1], label: 'TikTok' };
  }
  return null;
}

// ── SSRF-захист ──
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}
async function assertPublicHost(urlStr) {
  const host = new URL(urlStr).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('private address');
}

const clamp = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// кеш, щоб передпоказ і надсилання не тягнули сторінку двічі
const cache = new Map();

async function fetchPreview(startUrl) {
  const hit = cache.get(startUrl);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  const v = await fetchPreviewRaw(startUrl);
  cache.set(startUrl, { t: Date.now(), v });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}

async function fetchPreviewRaw(startUrl) {
  let url = startUrl, res;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHost(url);
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ModDropPreview/2.0; +https://ogp.me)', Accept: 'text/html,*/*;q=0.5', 'Accept-Language': 'uk,en;q=0.8' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      if (!safeHttpUrl(url)) throw new Error('bad redirect');
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error('status ' + res.status);
  const ct = res.headers.get('content-type') || '';
  if (ct.startsWith('image/')) return { image: url };
  if (!ct.includes('html')) return {};

  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  while (size < 1_500_000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
    if (Buffer.from(value).includes('</head>')) break;
  }
  reader.cancel().catch(() => {});
  const html = Buffer.concat(chunks).toString('utf8');

  const metas = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = n => { const m = tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
    const key = (attr('property') || attr('name') || '').toLowerCase();
    const val = attr('content');
    if (key && val && !(key in metas)) metas[key] = decodeEntities(val);
  }
  const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  let image = metas['og:image'] || metas['og:image:url'] || metas['og:image:secure_url'] || metas['twitter:image'] || '';
  if (image) { try { image = new URL(image, url).toString(); if (!safeHttpUrl(image)) image = ''; } catch { image = ''; } }
  return {
    title: clamp(metas['og:title'] || metas['twitter:title'] || decodeEntities(titleTag || ''), 200),
    description: clamp(metas['og:description'] || metas['twitter:description'] || metas['description'], 400),
    image,
    site: clamp(metas['og:site_name'], 80),
  };
}

module.exports = { safeHttpUrl, parseTime, detectEmbed, fetchPreview, clamp };
