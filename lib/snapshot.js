// Знімок сторінки «як є» (з картинками) через браузер, який уже стоїть на ПК (Edge / Chrome).
// Нічого не качаємо: puppeteer-core лише керує встановленим браузером у фоні (headless).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeHttpUrl, assertPublicHost } = require('./media');

const WIDTH = 1280;          // ширина «вікна» сторінки
const MAX_H = 5000;          // максимум висоти знімка (довгі сторінки обрізаються)
const IDLE_CLOSE = 3 * 60 * 1000;

function findBrowser() {
  const env = process.env;
  const list = [env.MODDROP_BROWSER];
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', la = env.LOCALAPPDATA || '';
    list.push(
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      la && path.join(la, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.find(p => p && fs.existsSync(p)) || null;
}

let browserP = null, idleTimer = null, active = 0;
const waiters = [];

async function getBrowser() {
  if (browserP) {
    const b = await browserP.catch(() => null);
    if (b && b.connected) return b;
    browserP = null;
  }
  const exe = findBrowser();
  if (!exe) throw new Error('Не знайдено Edge/Chrome для знімка сторінки');
  const puppeteer = require('puppeteer-core');
  browserP = puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
      '--disable-notifications', '--autoplay-policy=user-gesture-required', '--lang=uk-UA,uk,en',
      ...String(process.env.MODDROP_BROWSER_ARGS || '').split(' ').filter(Boolean)],
  });
  const b = await browserP;
  b.on('disconnected', () => { browserP = null; });
  return b;
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (active || !browserP) return;
    const b = await browserP.catch(() => null); browserP = null;
    if (b) b.close().catch(() => {});
  }, IDLE_CLOSE);
}

// не більше 2 знімків одночасно
async function slot() {
  if (active < 2) { active++; return; }
  await new Promise(r => waiters.push(r)); active++;
}
function release() { active--; const n = waiters.shift(); if (n) n(); armIdle(); }

// тільки публічні адреси — щоб через знімок не можна було зазирнути в локальну мережу стрімера
const hostOk = new Map();
async function allowed(u) {
  if (u.startsWith('data:') || u.startsWith('blob:')) return true;
  if (!safeHttpUrl(u)) return false;
  const host = new URL(u).hostname;
  if (!hostOk.has(host)) {
    hostOk.set(host, assertPublicHost(u).then(() => true, () => false));
    if (hostOk.size > 2000) hostOk.delete(hostOk.keys().next().value);
  }
  return hostOk.get(host);
}

const cache = new Map();

async function snapshot(url, outDir) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000 && fs.existsSync(path.join(outDir, hit.v.file))) return hit.v;
  if (hit && hit.p) return hit.p;
  const p = take(url, outDir);
  cache.set(url, { t: Date.now(), p });
  try {
    const v = await p;
    cache.set(url, { t: Date.now(), v });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return v;
  } catch (e) { cache.delete(url); throw e; }
}

async function take(url, outDir) {
  if (!(await allowed(url))) throw new Error('Адреса недоступна');
  await slot();
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: 900, deviceScaleFactor: 1 });
    const ua = (await browser.userAgent()).replace(/Headless/g, '');
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8' });
    await page.setBypassServiceWorker(true).catch(() => {});
    await page.setRequestInterception(true);
    page.on('request', async req => {
      try {
        const t = req.resourceType();
        if (t === 'media' || t === 'websocket' || t === 'eventsource') return req.abort();
        if (!(await allowed(req.url()))) return req.abort();
        req.continue();
      } catch { /* запит уже оброблено */ }
    });
    page.on('dialog', d => d.dismiss().catch(() => {}));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 8000 }).catch(() => {});

    // прибрати банери кукі / підписки, що висять поверх, і підвантажити ліниві картинки
    await page.evaluate(async (MAX_H) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
      document.querySelectorAll('img[data-src]').forEach(i => { if (!i.getAttribute('src') || i.src.startsWith('data:')) i.src = i.dataset.src; });
      const vw = innerWidth, vh = innerHeight;
      const kill = () => {
        for (const e of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(e);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const r = e.getBoundingClientRect();
          const big = r.width * r.height > vw * vh * 0.25;
          const txt = (e.innerText || '').toLowerCase();
          if (big || /cookie|кукі|cookies|consent|згод|gdpr|privacy|підпис|subscribe|newsletter|реклам/.test(txt)) e.remove();
          else e.style.position = cs.position === 'sticky' ? 'relative' : 'absolute';
        }
        for (const el of [document.documentElement, document.body]) { if (el) { el.style.overflow = 'visible'; el.style.height = 'auto'; } }
      };
      kill();
      const h = Math.min(document.documentElement.scrollHeight, MAX_H);
      for (let y = 0; y < h; y += 700) { scrollTo(0, y); await sleep(120); }
      scrollTo(0, 0); await sleep(400);
      kill();
    }, MAX_H);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

    const meta = await page.evaluate(() => {
      const m = n => (document.querySelector(`meta[property="${n}"],meta[name="${n}"]`) || {}).content || '';
      return {
        title: m('og:title') || document.title || '',
        description: m('og:description') || m('description') || '',
        site: m('og:site_name') || '',
        image: m('og:image') || '',
        height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      };
    });
    const height = Math.max(400, Math.min(meta.height || 900, MAX_H));
    const file = 'page-' + crypto.randomBytes(10).toString('hex') + '.jpg';
    await page.screenshot({ path: path.join(outDir, file), type: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: WIDTH, height }, captureBeyondViewport: true });
    const cut = s => String(s || '').replace(/\s+/g, ' ').trim();
    let image = '';
    try { image = meta.image ? new URL(meta.image, page.url()).toString() : ''; if (!safeHttpUrl(image)) image = ''; } catch {}
    return { file, width: WIDTH, height, title: cut(meta.title).slice(0, 200), description: cut(meta.description).slice(0, 400), site: cut(meta.site).slice(0, 80), image };
  } finally {
    if (page) page.close().catch(() => {});
    release();
  }
}

module.exports = { snapshot, findBrowser };
