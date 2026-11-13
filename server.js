// 🌻 Mod Drop — модери кидають картинку / відео / аудіо / текст / статтю, і воно одразу показується на стрімі.
//
//   http://localhost:PORT/setup   — налаштування (тільки з цього ПК), ключі шифруються майстер-паролем
//   /                              — панель модерів (вхід через Twitch)
//   /overlay?key=…                 — оверлей для OBS (Browser Source 1920×1080)

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const cookieSession = require('cookie-session');
const multer = require('multer');
const { Store } = require('./lib/store');
const updater = require('./lib/updater');
const rufilter = require('./lib/rufilter');
const search = require('./lib/search');
const { safeHttpUrl, parseTime, detectEmbed, fetchPreview, clamp } = require('./lib/media');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const store = new Store(path.join(DATA_DIR, 'config.enc'));
const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

const DEFAULTS = () => ({
  channel: '',
  twitchClientId: '',
  twitchClientSecret: '',
  ngrokEnabled: true,
  ngrokAuthtoken: '',
  ngrokDomain: '',
  publicUrl: '',
  overlayKey: rand(18),
  sessionSecret: rand(32),
  extraUsers: '',
  maxUploadMb: 200,
  defaultDuration: 15,
  defaultCooldown: 5,
  devLogin: false,
  users: {},   // керування доступом: login → { status, twitchMod, pausedUntil, cooldown, … }
  favorites: [],
  giphyKey: '',
  notify: { where: 'overlay', sound: 'chime', volume: 70 },
  filterRu: true,   // приховувати російський контент у пошуку
});

// ───────────────────────── Runtime-стан ─────────────────────────
let cfg = null;              // розшифровані налаштування (null = сервіс заблокований)
let masterPassword = null;   // у пам'яті процесу, щоб перешифрувати при збереженні
let adminToken = null;       // сесія сторінки налаштувань
let sessionMw = null;
const tunnel = { status: 'off', url: '', error: '', listener: null };

const state = { enabled: true, current: null, history: [] };
let hideTimer = null;
const lastSend = new Map();
const overlayClients = new Set();
const panelClients = new Map(); // res → { login, role }

const SAFE_FIELDS = Object.keys(DEFAULTS());
function sanitizeConfig(input, base) {
  const c = { ...base };
  for (const k of SAFE_FIELDS) if (k in input) c[k] = input[k];
  c.channel = String(c.channel || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 25);
  for (const k of ['twitchClientId', 'twitchClientSecret', 'ngrokAuthtoken', 'overlayKey', 'sessionSecret', 'extraUsers'])
    c[k] = String(c[k] || '').trim().slice(0, 300);
  c.ngrokDomain = String(c.ngrokDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().slice(0, 200);
  c.publicUrl = String(c.publicUrl || '').trim().replace(/\/+$/, '').slice(0, 300);
  if (c.publicUrl && !safeHttpUrl(c.publicUrl)) c.publicUrl = '';
  c.ngrokEnabled = !!c.ngrokEnabled;
  c.devLogin = !!c.devLogin;
  c.maxUploadMb = Math.min(2000, Math.max(1, Number(c.maxUploadMb) || 200));
  c.defaultDuration = Math.min(600, Math.max(3, Number(c.defaultDuration) || 15));
  if (c.overlayKey.length < 8) c.overlayKey = rand(18);
  if (c.sessionSecret.length < 16) c.sessionSecret = rand(32);
  c.defaultCooldown = Math.min(3600, Math.max(0, Math.round(Number(c.defaultCooldown ?? 5)) || 0));
  c.users = sanitizeUsers(c.users);
  c.filterRu = c.filterRu !== false;
  c.giphyKey = String(c.giphyKey || '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  c.favorites = (Array.isArray(c.favorites) ? c.favorites : []).filter(f => f && typeof f === 'object' && TYPES.includes(f.type) && f.fid).slice(0, 100);
  const n = c.notify && typeof c.notify === 'object' ? c.notify : {};
  c.notify = {
    where: ['overlay', 'panel', 'both', 'off'].includes(n.where) ? n.where : 'overlay',
    sound: SOUND_NAMES.includes(n.sound) ? n.sound : 'chime',
    volume: Math.min(100, Math.max(0, Math.round(Number(n.volume ?? 70)))),
  };
  // старе поле «додаткові люди» → список доступу
  for (const l of c.extraUsers.toLowerCase().split(/[,\s]+/).map(x => x.replace(/^@/, '').replace(/[^a-z0-9_]/g, '')).filter(Boolean)) {
    if (!c.users[l]) c.users[l] = { login: l, name: l, avatar: '', status: 'allow', twitchMod: false, source: 'manual', addedAt: Date.now() };
  }
  c.extraUsers = '';
  return c;
}

const STATUSES = ['default', 'allow', 'block'];
const TYPES = ['image', 'gif', 'video', 'audio', 'text', 'article'];
const SOUND_NAMES = ['chime', 'ping', 'pop', 'harp', 'bell', 'alert'];
function sanitizeUsers(u) {
  const out = {};
  if (!u || typeof u !== 'object') return out;
  for (const [k, v] of Object.entries(u).slice(0, 2000)) {
    const login = String(k).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
    if (!login || !v || typeof v !== 'object') continue;
    out[login] = {
      login, id: String(v.id || '').slice(0, 30), name: String(v.name || login).slice(0, 40), avatar: safeHttpUrl(v.avatar) || '',
      status: STATUSES.includes(v.status) ? v.status : 'default',
      twitchMod: !!v.twitchMod, source: String(v.source || 'login').slice(0, 10),
      pausedUntil: Number(v.pausedUntil) || 0,
      cooldown: v.cooldown == null || v.cooldown === '' ? null : Math.min(3600, Math.max(0, Math.round(+v.cooldown) || 0)),
      lastSeen: Number(v.lastSeen) || 0, addedAt: Number(v.addedAt) || 0, sent: Number(v.sent) || 0,
    };
  }
  return out;
}

// ── доступ модерів ──
function accessRole(login, twitchMod) {
  if (!cfg) return null;
  if (login === cfg.channel) return 'broadcaster';
  const u = cfg.users[login];
  if (u && u.status === 'block') return null;
  if (u && u.status === 'allow') return 'mod';
  return twitchMod || (u && u.twitchMod) ? 'mod' : null;
}
function upsertUser(login, patch) {
  const prev = cfg.users[login] || { login, name: login, avatar: '', status: 'default', twitchMod: false, source: 'login', pausedUntil: 0, cooldown: null, lastSeen: 0, addedAt: Date.now(), sent: 0 };
  cfg.users[login] = sanitizeUsers({ [login]: { ...prev, ...patch } })[login];
  persistSoon();
  return cfg.users[login];
}
let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (cfg && masterPassword) store.save(cfg, masterPassword).catch(e => console.error('save users:', e.message));
  }, 600);
}
const effCooldown = login => { const u = cfg.users[login]; return u && u.cooldown != null ? u.cooldown : cfg.defaultCooldown; };
function myLimits(user) {
  if (!user || user.role === 'broadcaster') return { cooldown: 0, cooldownLeft: 0, pausedUntil: 0 };
  const u = cfg.users[user.login] || {};
  const cd = effCooldown(user.login);
  const left = Math.max(0, Math.ceil((lastSend.get(user.login) || 0) / 1000 + cd - Date.now() / 1000));
  return { cooldown: cd, cooldownLeft: left, pausedUntil: u.pausedUntil > Date.now() ? u.pausedUntil : 0 };
}
function modsList() {
  return Object.values(cfg.users)
    .filter(u => u.login !== cfg.channel)
    .map(u => ({ ...u, online: [...panelClients.values()].some(c => c.login === u.login) }))
    .sort((a, b) => (b.online - a.online) || ((b.twitchMod || b.status === 'allow') - (a.twitchMod || a.status === 'allow')) || a.login.localeCompare(b.login));
}
function sendToUser(login, event, data) {
  for (const [res, c] of panelClients) if (c.login === login) sse(res, event, data);
}
function notifyMods() {
  const list = modsList();
  for (const [res, c] of panelClients) if (c.role === 'broadcaster') sse(res, 'mods', { mods: list, defaultCooldown: cfg.defaultCooldown });
}

const localUrl = () => `http://localhost:${PORT}`;
function publicUrl() {
  if (!cfg) return localUrl();
  if (cfg.ngrokEnabled && tunnel.url) return tunnel.url;
  if (!cfg.ngrokEnabled && cfg.publicUrl) return cfg.publicUrl;
  if (cfg.ngrokEnabled && cfg.ngrokDomain) return `https://${cfg.ngrokDomain}`;
  return localUrl();
}
const redirectUri = () => `${publicUrl()}/auth/callback`;

function urls() {
  if (!cfg) return null;
  const k = encodeURIComponent(cfg.overlayKey);
  return {
    panel: publicUrl() + '/',
    panelLocal: localUrl() + '/',
    overlayLocal: `${localUrl()}/overlay?key=${k}`,
    overlayPublic: `${publicUrl()}/overlay?key=${k}`,
    redirect: redirectUri(),
  };
}

async function applyConfig(next, prev) {
  cfg = next;
  sessionMw = cookieSession({
    name: 'moddrop', keys: [cfg.sessionSecret], maxAge: 12 * 60 * 60 * 1000,
    sameSite: 'lax', httpOnly: true,
  });
  const tunnelChanged = !prev || prev.ngrokEnabled !== cfg.ngrokEnabled || prev.ngrokAuthtoken !== cfg.ngrokAuthtoken || prev.ngrokDomain !== cfg.ngrokDomain;
  if (tunnelChanged) await restartTunnel();
}

async function restartTunnel() {
  await stopTunnel();
  if (!cfg || !cfg.ngrokEnabled) return;
  if (!cfg.ngrokAuthtoken) { tunnel.status = 'error'; tunnel.error = 'Не вказано ngrok authtoken'; return; }
  tunnel.status = 'starting'; tunnel.error = '';
  try {
    const ngrok = require('@ngrok/ngrok');
    const opts = { addr: PORT, authtoken: cfg.ngrokAuthtoken };
    if (cfg.ngrokDomain) opts.domain = cfg.ngrokDomain;
    tunnel.listener = await ngrok.forward(opts);
    tunnel.url = tunnel.listener.url();
    tunnel.status = 'on';
    console.log(`🌍 ngrok: ${tunnel.url}`);
  } catch (e) {
    tunnel.status = 'error';
    tunnel.error = humanNgrokError(e);
    console.error('ngrok error:', e.message);
  }
  broadcastPanels();
}
async function stopTunnel() {
  if (tunnel.listener) { try { await tunnel.listener.close(); } catch {} }
  tunnel.listener = null; tunnel.url = ''; tunnel.status = 'off'; tunnel.error = '';
}
function humanNgrokError(e) {
  const m = String(e && e.message || e);
  if (/ERR_NGROK_105|authtoken.*(invalid|not valid)/i.test(m)) return 'Невірний ngrok authtoken. Скопіюй його ще раз із dashboard.ngrok.com.';
  if (/ERR_NGROK_108|simultaneous/i.test(m)) return 'Тунель ngrok уже запущено в іншому місці (безкоштовно можна лише 1). Закрий інший ngrok.';
  if (/ERR_NGROK_3200|ERR_NGROK_320|domain/i.test(m)) return 'Домен ngrok не знайдено або він не твій. Перевір його в dashboard.ngrok.com → Domains.';
  if (/Cannot find module/i.test(m)) return 'Пакет ngrok не встановлено. Запусти npm install.';
  return m.slice(0, 300);
}

function lockService() {
  clearTimeout(hideTimer);
  cfg = null; masterPassword = null; adminToken = null; sessionMw = null;
  state.current = null;
  clearTimeout(persistTimer);
  for (const c of [...overlayClients, ...panelClients.keys()]) { try { c.end(); } catch {} }
  overlayClients.clear(); panelClients.clear();
  return stopTunnel();
}

// ───────────────────────── SSE ─────────────────────────
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcastOverlay(event, data) { for (const c of overlayClients) sse(c, event, data); }
function publicState() {
  return {
    enabled: state.enabled, current: state.current, history: state.history, overlays: overlayClients.size,
    favorites: cfg ? cfg.favorites : [], notify: cfg ? cfg.notify : null, filterRu: cfg ? cfg.filterRu : true,
  };
}
function broadcastPanels() { const s = publicState(); for (const c of panelClients.keys()) sse(c, 'state', s); }

function showItem(item) {
  clearTimeout(hideTimer);
  state.current = { ...item, shownAt: Date.now() };
  const n = cfg.notify;
  broadcastOverlay('show', { ...state.current, notify: n.where === 'overlay' || n.where === 'both' ? { sound: n.sound, volume: n.volume } : null });
  if (item.duration > 0) hideTimer = setTimeout(() => hideCurrent('timeout'), item.duration * 1000 + 800);
  broadcastPanels();
}
function hideCurrent(reason) {
  clearTimeout(hideTimer);
  if (!state.current) return;
  state.current = null;
  broadcastOverlay('hide', { reason });
  broadcastPanels();
}

// ───────────────────────── App ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Запит прийшов саме з цього ПК (а не через ngrok / мережу)
function isLocal(req) {
  const ra = req.socket.remoteAddress || '';
  const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return loop && ['localhost', '127.0.0.1', '::1'].includes(host) &&
    !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-proto'];
}
function sameOrigin(req) {
  const o = req.headers.origin;
  return !!o && o === `http://${req.headers.host}`;
}
function cookies(req) {
  const out = {};
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
function isAdmin(req) {
  const t = cookies(req).md_admin || '';
  if (!adminToken || t.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(adminToken));
}
function setAdminCookie(res) {
  adminToken = rand(32);
  res.setHeader('Set-Cookie', `md_admin=${adminToken}; Path=/; HttpOnly; SameSite=Strict`);
}

// сесії (активні тільки коли сервіс розблоковано)
app.use((req, res, next) => (sessionMw ? sessionMw(req, res, next) : next()));

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1h' }));

// ═════════════════════ Налаштування (тільки локально) ═════════════════════
const setup = express.Router();
setup.use((req, res, next) => {
  if (!isLocal(req)) return res.status(403).send('Налаштування доступні тільки на комп\'ютері стрімера: http://localhost:' + PORT + '/setup');
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  next();
});
setup.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

setup.get('/api/status', (req, res) => {
  const authed = isAdmin(req);
  res.json({
    initialized: store.exists(), unlocked: !!cfg, authed, port: PORT,
    tunnel: { status: tunnel.status, url: tunnel.url, error: tunnel.error },
    urls: authed ? urls() : null,
    config: authed ? cfg : null,
    defaults: !store.exists() ? DEFAULTS() : null,
  });
});

let failDelay = 0;
setup.post('/api/init', async (req, res) => {
  if (store.exists()) return res.status(400).json({ error: 'Вже налаштовано' });
  const { password, config } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Майстер-пароль — мінімум 8 символів' });
  const c = sanitizeConfig(config || {}, DEFAULTS());
  await store.save(c, password);
  masterPassword = password;
  await applyConfig(c, null);
  setAdminCookie(res);
  console.log('🔐 Налаштування створено і зашифровано');
  res.json({ ok: true });
});

setup.post('/api/unlock', async (req, res) => {
  const password = String((req.body || {}).password || '');
  try {
    const loaded = await store.load(password);
    failDelay = 0;
    if (!cfg) {
      masterPassword = password;
      await applyConfig(sanitizeConfig(loaded, DEFAULTS()), null);
      console.log('🔓 Розблоковано, сервіс запущено');
    }
    setAdminCookie(res);
    res.json({ ok: true });
  } catch (e) {
    if (e.code !== 'WRONG_PASSWORD') { console.error(e); return res.status(500).json({ error: 'Файл налаштувань пошкоджено' }); }
    failDelay = Math.min(failDelay + 1000, 8000);
    await new Promise(r => setTimeout(r, failDelay));
    res.status(401).json({ error: 'Невірний пароль' });
  }
});

setup.post('/api/logout', (req, res) => {
  adminToken = null;
  res.setHeader('Set-Cookie', 'md_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  res.json({ ok: true });
});

const requireAdmin = (req, res, next) => (isAdmin(req) && cfg ? next() : res.status(401).json({ error: 'Потрібно увійти' }));

setup.post('/api/save', requireAdmin, async (req, res) => {
  const { config, newPassword, currentPassword } = req.body || {};
  let pw = masterPassword;
  if (newPassword) {
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'Новий пароль — мінімум 8 символів' });
    if (currentPassword !== masterPassword) return res.status(400).json({ error: 'Поточний пароль невірний' });
    pw = String(newPassword);
  }
  const prev = cfg;
  const next = sanitizeConfig(config || {}, cfg);
  await store.save(next, pw);
  masterPassword = pw;
  await applyConfig(next, prev);
  res.json({ ok: true });
});

setup.post('/api/regen-key', requireAdmin, async (req, res) => {
  const next = { ...cfg, overlayKey: rand(18) };
  await store.save(next, masterPassword);
  cfg = next;
  for (const c of overlayClients) { try { c.end(); } catch {} }
  overlayClients.clear();
  res.json({ ok: true });
});

setup.post('/api/tunnel/restart', requireAdmin, async (req, res) => { await restartTunnel(); res.json({ ok: true, tunnel: { status: tunnel.status, url: tunnel.url, error: tunnel.error } }); });

setup.post('/api/lock', requireAdmin, async (req, res) => {
  await lockService();
  res.setHeader('Set-Cookie', 'md_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  console.log('🔒 Сервіс заблоковано');
  res.json({ ok: true });
});

setup.post('/api/reset', async (req, res) => {
  // повне скидання — тільки якщо введено слово ВИДАЛИТИ (на випадок забутого пароля)
  if ((req.body || {}).confirm !== 'ВИДАЛИТИ') return res.status(400).json({ error: 'Потрібне підтвердження' });
  await lockService();
  try { fs.unlinkSync(store.path); } catch {}
  res.json({ ok: true });
});

// ═════ Оновлення з GitHub ═════
setup.get('/api/update', requireAdmin, async (req, res) => {
  if (req.query.force === '1' || !upd.checkedAt) await checkUpdates();
  res.json(updView());
});
setup.post('/api/update/apply', requireAdmin, async (req, res) => {
  if (upd.installing) return res.status(409).json({ error: 'Оновлення вже йде' });
  await checkUpdates();
  if (!upd.available) return res.status(400).json({ error: upd.error || 'Нової версії немає' });
  upd.installing = true; upd.stage = 'Завантажую з GitHub…';
  res.json({ ok: true });
  try {
    const zip = path.join(DATA_DIR, 'update.zip');
    await updater.download(upd.remote.sha, zip);
    upd.stage = 'Встановлюю файли…';
    const { depsChanged } = updater.installFromZip(zip, __dirname, m => console.log('🔄', m));
    fs.rmSync(zip, { force: true });
    if (depsChanged) { upd.stage = 'Встановлюю залежності (npm install)…'; await updater.npmInstall(__dirname); }
    fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify({ date: upd.remote.date, sha: upd.remote.sha, branch: upd.remote.branch }, null, 2));
    upd.stage = 'Перезапуск…';
    console.log(`✅ Оновлено до ${upd.remote.sha.slice(0, 7)} — перезапуск`);
    setTimeout(restartProcess, 600);
  } catch (e) {
    console.error('update failed:', e);
    upd.installing = false; upd.stage = ''; upd.error = 'Не вдалося оновити: ' + e.message;
  }
});
setup.get('/api/update/progress', (req, res) => res.json({ installing: upd.installing, stage: upd.stage, error: upd.error }));

app.use('/setup', setup);

const upd = { local: updater.readLocal(__dirname), remote: null, available: false, checkedAt: 0, error: '', installing: false, stage: '' };
let updChecking = null;
async function checkUpdates() {
  if (updChecking) return updChecking;
  updChecking = (async () => {
    try {
      upd.remote = await updater.fetchRemote();
      upd.available = updater.isNewer(upd.remote, upd.local);
      upd.error = '';
    } catch (e) { upd.error = e.message; upd.available = false; }
    upd.checkedAt = Date.now();
    updChecking = null;
  })();
  return updChecking;
}
const updView = () => ({ ...upd, repo: updater.REPO_URL });
async function restartProcess() {
  await stopTunnel();
  if (process.env.MODDROP_LAUNCHER) process.exit(42);   // launcher.js перезапустить
  const { spawn } = require('child_process');
  spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore', env: { ...process.env, NO_OPEN: '1' } }).unref();
  process.exit(0);
}
setTimeout(checkUpdates, 5000);
setInterval(checkUpdates, 6 * 60 * 60 * 1000);

// ═════════════════════ Twitch OAuth ═════════════════════
const ready = (req, res, next) => (cfg ? next() : res.status(503).json({ error: 'Сервіс ще не запущено' }));

app.get('/auth/login', (req, res) => {
  if (!cfg) return res.redirect('/');
  if (!cfg.twitchClientId) return res.redirect('/?err=' + encodeURIComponent('Twitch ще не налаштовано (/setup)'));
  const st = rand(16);
  req.session.oauthState = st;
  // ?sync=1 — стрімер дає дозвіл прочитати список модерів каналу
  req.session.oauthSync = req.query.sync === '1';
  const u = new URL('https://id.twitch.tv/oauth2/authorize');
  u.searchParams.set('client_id', cfg.twitchClientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'user:read:moderated_channels' + (req.session.oauthSync ? ' moderation:read' : ''));
  if (req.session.oauthSync) u.searchParams.set('force_verify', 'true');
  u.searchParams.set('state', st);
  res.redirect(u.toString());
});

app.get('/auth/callback', async (req, res) => {
  if (!cfg) return res.redirect('/');
  try {
    const { code, state: st, error } = req.query;
    if (error) return res.redirect('/?err=' + encodeURIComponent('Вхід скасовано'));
    if (!code || !st || st !== req.session.oauthState) return res.redirect('/?err=' + encodeURIComponent('Сесія входу застаріла, спробуй ще раз'));
    req.session.oauthState = null;

    const tokRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.twitchClientId, client_secret: cfg.twitchClientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri() }),
    });
    if (!tokRes.ok) throw new Error('token ' + tokRes.status + ' ' + await tokRes.text());
    const { access_token } = await tokRes.json();
    const H = { 'Client-Id': cfg.twitchClientId, Authorization: `Bearer ${access_token}` };

    const meRes = await fetch('https://api.twitch.tv/helix/users', { headers: H });
    if (!meRes.ok) throw new Error('users ' + meRes.status);
    const me = (await meRes.json()).data[0];

    const sync = !!req.session.oauthSync; req.session.oauthSync = null;
    let twitchMod = false;
    if (me.login !== cfg.channel) twitchMod = await isModOf(H, me.id, cfg.channel);
    const role = accessRole(me.login, twitchMod);
    let synced = null;
    if (role === 'broadcaster' && sync) {
      try { synced = await syncModerators(H, me.id); } catch (e) { console.error('sync mods:', e.message); synced = -1; }
    }

    fetch('https://id.twitch.tv/oauth2/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.twitchClientId, token: access_token }),
    }).catch(() => {});

    if (!role) {
      req.session.user = null;
      const blocked = cfg.users[me.login] && cfg.users[me.login].status === 'block';
      if (cfg.users[me.login]) upsertUser(me.login, { twitchMod });
      return res.redirect('/?err=' + encodeURIComponent(blocked ? `@${me.login}, стрімер закрив тобі доступ` : `@${me.login} не є модератором каналу ${cfg.channel}`));
    }
    if (role === 'mod') upsertUser(me.login, { id: me.id, name: me.display_name, avatar: me.profile_image_url, twitchMod, lastSeen: Date.now() });
    req.session.user = { id: me.id, login: me.login, name: me.display_name, avatar: me.profile_image_url, role };
    console.log(`✅ Вхід: ${me.login} (${role})`);
    res.redirect(synced == null ? '/' : synced < 0 ? '/?msg=' + encodeURIComponent('Не вдалося отримати список модерів з Twitch') : '/?msg=' + encodeURIComponent(`Синхронізовано модерів: ${synced}`));
  } catch (e) {
    console.error('OAuth error:', e.message);
    res.redirect('/?err=' + encodeURIComponent('Помилка входу через Twitch. Перевір Client ID / Secret і Redirect URL.'));
  }
});

async function isModOf(headers, userId, channelLogin) {
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const u = new URL('https://api.twitch.tv/helix/moderation/channels');
    u.searchParams.set('user_id', userId); u.searchParams.set('first', '100');
    if (cursor) u.searchParams.set('after', cursor);
    const r = await fetch(u, { headers });
    if (!r.ok) throw new Error('moderated_channels ' + r.status);
    const j = await r.json();
    if (j.data.some(c => c.broadcaster_login === channelLogin)) return true;
    cursor = j.pagination && j.pagination.cursor;
    if (!cursor) return false;
  }
  return false;
}

// Список модерів каналу (потрібен токен стрімера з moderation:read)
async function syncModerators(H, broadcasterId) {
  const found = [];
  let cursor = '';
  for (let i = 0; i < 30; i++) {
    const u = new URL('https://api.twitch.tv/helix/moderation/moderators');
    u.searchParams.set('broadcaster_id', broadcasterId); u.searchParams.set('first', '100');
    if (cursor) u.searchParams.set('after', cursor);
    const r = await fetch(u, { headers: H });
    if (!r.ok) throw new Error('moderators ' + r.status);
    const j = await r.json();
    found.push(...j.data.map(m => m.user_login));
    cursor = j.pagination && j.pagination.cursor;
    if (!cursor) break;
  }
  const profiles = await twitchUsers(found, H);
  const set = new Set(found);
  for (const u of Object.values(cfg.users)) if (u.twitchMod && !set.has(u.login)) upsertUser(u.login, { twitchMod: false });
  for (const login of found) {
    const p = profiles[login] || {};
    upsertUser(login, { twitchMod: true, id: p.id || '', name: p.display_name || login, avatar: p.profile_image_url || '', source: (cfg.users[login] || {}).source || 'twitch' });
  }
  notifyMods();
  return found.length;
}
async function twitchUsers(logins, headers) {
  const out = {};
  for (let i = 0; i < logins.length; i += 100) {
    const u = new URL('https://api.twitch.tv/helix/users');
    logins.slice(i, i + 100).forEach(l => u.searchParams.append('login', l));
    const r = await fetch(u, { headers });
    if (!r.ok) continue;
    for (const d of (await r.json()).data) out[d.login] = d;
  }
  return out;
}
let appToken = null;
async function appHeaders() {
  if (!cfg.twitchClientId || !cfg.twitchClientSecret) return null;
  if (!appToken || appToken.exp < Date.now() + 60000 || appToken.cid !== cfg.twitchClientId) {
    const r = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.twitchClientId, client_secret: cfg.twitchClientSecret, grant_type: 'client_credentials' }),
    });
    if (!r.ok) throw new Error('app token ' + r.status);
    const j = await r.json();
    appToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000, cid: cfg.twitchClientId };
  }
  return { 'Client-Id': cfg.twitchClientId, Authorization: `Bearer ${appToken.token}` };
}

// Вхід стрімера з цього ПК без Twitch
app.get('/auth/local', (req, res) => {
  if (!cfg || !isLocal(req)) return res.redirect('/');
  const login = cfg.channel || 'streamer';
  req.session.user = { id: 'local', login, name: login, avatar: '', role: 'broadcaster' };
  res.redirect('/');
});
// DEV-вхід (для тесту, вмикається в налаштуваннях)
app.get('/auth/dev', (req, res) => {
  if (!cfg || !cfg.devLogin) return res.status(404).end();
  const login = String(req.query.login || 'test_mod').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25) || 'test_mod';
  if (login !== cfg.channel) {
    if (!accessRole(login, true)) return res.redirect('/?err=' + encodeURIComponent('Доступ закрито'));
    upsertUser(login, { twitchMod: true, source: (cfg.users[login] || {}).source || 'dev', lastSeen: Date.now() });
  }
  req.session.user = { id: 'dev-' + login, login, name: login, avatar: '', role: login === cfg.channel ? 'broadcaster' : 'mod' };
  res.redirect('/');
});
app.post('/auth/logout', (req, res) => { if (req.session) req.session = null; res.json({ ok: true }); });

function requireUser(req, res, next) {
  if (!cfg) return res.status(503).json({ error: 'Сервіс ще не запущено' });
  const u = req.session && req.session.user;
  if (!u) return res.status(401).json({ error: 'Потрібно увійти' });
  // доступ можуть забрати будь-коли — перевіряємо на кожному запиті
  if (u.role !== 'broadcaster' && !accessRole(u.login, false)) {
    req.session = null;
    return res.status(401).json({ error: 'Доступ закрито' });
  }
  req.user = u; next();
}
function canSend(user) {
  if (user.role === 'broadcaster') return;
  if (!state.enabled) throw new UserError('Стрімер зараз вимкнув показ');
  const lim = myLimits(user);
  if (lim.pausedUntil) throw new UserError(`Тебе призупинено до ${new Date(lim.pausedUntil).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}`);
  if (lim.cooldownLeft > 0) throw new UserError(`Кулдаун: зачекай ще ${lim.cooldownLeft} с`);
}
function markSent(user) {
  lastSend.set(user.login, Date.now());
  if (user.role !== 'broadcaster' && cfg.users[user.login]) { cfg.users[user.login].sent++; cfg.users[user.login].lastSeen = Date.now(); persistSoon(); }
  sendToUser(user.login, 'me', myLimits(user));
}
const requireBroadcaster = (req, res, next) => (req.user.role === 'broadcaster' ? next() : res.status(403).json({ error: 'Тільки для стрімера' }));

// ═════════════════════ Файли ═════════════════════
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.weba', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
};
const EXT_MIME = { '.weba': 'audio/webm', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.mov': 'video/quicktime', '.avif': 'image/avif' };
function makeUpload() {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + MIME_EXT[file.mimetype]),
    }),
    limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1, fields: 30 },
    fileFilter: (req, file, cb) => (MIME_EXT[file.mimetype] ? cb(null, true) : cb(new UserError('Такий формат не підтримується'))),
  }).single('file');
}
app.use('/media', express.static(UPLOAD_DIR, {
  maxAge: '1h',
  setHeaders: (res, p) => {
    const m = EXT_MIME[path.extname(p)]; if (m) res.setHeader('Content-Type', m);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  },
}));

// ═════════════════════ API панелі ═════════════════════
app.get('/api/me', (req, res) => {
  const local = isLocal(req);
  if (!cfg) return res.json({ ready: false, isLocal: local });
  let u = (req.session && req.session.user) || null;
  if (u && u.role !== 'broadcaster' && !accessRole(u.login, false)) { req.session = null; u = null; }
  res.json({
    ready: true, isLocal: local, user: u, channel: cfg.channel, devLogin: cfg.devLogin,
    twitchReady: !!(cfg.twitchClientId && cfg.twitchClientSecret),
    urls: u && u.role === 'broadcaster' ? urls() : null,
    maxUploadMb: cfg.maxUploadMb, defaultDuration: cfg.defaultDuration,
    limits: u ? myLimits(u) : null,
    updateAvailable: !!(u && u.role === 'broadcaster' && local && upd.available),
  });
});

app.get('/api/state', requireUser, (req, res) => res.json(publicState()));
app.get('/api/events', requireUser, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  sse(res, 'state', publicState());
  sse(res, 'me', myLimits(req.user));
  panelClients.set(res, { login: req.user.login, role: req.user.role });
  if (req.user.role === 'broadcaster') sse(res, 'mods', { mods: modsList(), defaultCooldown: cfg.defaultCooldown });
  notifyMods();
  req.on('close', () => { panelClients.delete(res); notifyMods(); });
});

// ═════ Керування модерами (стрімер) ═════
app.get('/api/mods', requireUser, requireBroadcaster, (req, res) => res.json({ mods: modsList(), defaultCooldown: cfg.defaultCooldown }));

app.post('/api/mods/add', requireUser, requireBroadcaster, async (req, res) => {
  const login = String((req.body || {}).login || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 25);
  if (!login || login === cfg.channel) return res.status(400).json({ error: 'Невірний логін' });
  let p = {};
  try { const H = await appHeaders(); if (H) p = (await twitchUsers([login], H))[login] || null; } catch (e) { console.warn('lookup:', e.message); }
  if (p === null) return res.status(404).json({ error: `Користувача @${login} не знайдено на Twitch` });
  upsertUser(login, { status: 'allow', source: 'manual', id: p.id || '', name: p.display_name || login, avatar: p.profile_image_url || '' });
  notifyMods();
  res.json({ ok: true });
});

app.post('/api/mods/:login', requireUser, requireBroadcaster, (req, res) => {
  const login = String(req.params.login).toLowerCase();
  if (!cfg.users[login]) return res.status(404).json({ error: 'Не знайдено' });
  const b = req.body || {};
  const patch = {};
  if (STATUSES.includes(b.status)) patch.status = b.status;
  if (b.pauseMinutes != null) patch.pausedUntil = +b.pauseMinutes > 0 ? Date.now() + Math.min(+b.pauseMinutes, 60 * 24 * 7) * 60000 : 0;
  if ('cooldown' in b) patch.cooldown = b.cooldown === null || b.cooldown === '' ? null : b.cooldown;
  const u = upsertUser(login, patch);
  if (u.status === 'block') sendToUser(login, 'kicked', {});
  else sendToUser(login, 'me', myLimits({ login, role: 'mod' }));
  notifyMods();
  res.json({ ok: true });
});

app.delete('/api/mods/:login', requireUser, requireBroadcaster, (req, res) => {
  const login = String(req.params.login).toLowerCase();
  delete cfg.users[login]; persistSoon();
  if (!accessRole(login, false)) sendToUser(login, 'kicked', {});
  notifyMods();
  res.json({ ok: true });
});

// розпізнати посилання для передпоказу
app.post('/api/resolve', requireUser, async (req, res) => {
  const { type } = req.body || {};
  const url = safeHttpUrl((req.body || {}).url);
  if (!url) return res.status(400).json({ error: 'Невірне посилання' });
  if (type === 'article') {
    try { return res.json({ meta: await fetchPreview(url) }); }
    catch (e) { return res.json({ meta: {}, warn: 'Не вдалося отримати прев\'ю сторінки' }); }
  }
  const embed = detectEmbed(url);
  if (type === 'audio' && embed && embed.kind !== 'youtube') return res.json({ error: 'Для аудіо підтримується YouTube або пряме посилання на файл' });
  const info = embed && embed.kind === 'youtube' ? await youtubeInfo(embed.id) : embed && embed.kind === 'twitchclip' ? await clipInfo(embed.id) : {};
  res.json({ embed, info });
});

app.post('/api/show', requireUser, (req, res) => {
  makeUpload()(req, res, async err => {
    const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    try {
      if (err) throw new UserError(err.code === 'LIMIT_FILE_SIZE' ? `Файл завеликий (макс. ${cfg.maxUploadMb} МБ)` : err.message);
      canSend(req.user);
      const item = await buildItem(req);
      markSent(req.user);
      state.history.unshift(item);
      state.history = state.history.slice(0, 30);
      showItem(item);
      console.log(`📤 ${req.user.login} → ${item.type}`);
      res.json({ ok: true, item });
    } catch (e) {
      cleanup();
      if (!(e instanceof UserError)) console.error(e);
      res.status(400).json({ error: e instanceof UserError ? e.message : 'Щось пішло не так' });
    }
  });
});

app.post('/api/hide', requireUser, (req, res) => { hideCurrent('manual'); res.json({ ok: true }); });
app.post('/api/reshow/:id', requireUser, (req, res) => {
  try { canSend(req.user); } catch (e) { return res.status(400).json({ error: e.message }); }
  const item = state.history.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Не знайдено' });
  markSent(req.user);
  showItem(item); res.json({ ok: true });
});
app.post('/api/toggle', requireUser, requireBroadcaster, (req, res) => {
  state.enabled = !!(req.body || {}).enabled;
  if (!state.enabled) hideCurrent('disabled');
  broadcastPanels(); res.json({ ok: true, enabled: state.enabled });
});
app.post('/api/settings', requireUser, requireBroadcaster, async (req, res) => {
  const b = req.body || {};
  if (b.defaultCooldown != null) cfg.defaultCooldown = Math.min(3600, Math.max(0, Math.round(+b.defaultCooldown) || 0));
  if (typeof b.filterRu === 'boolean') { cfg.filterRu = b.filterRu; searchCache.clear(); }
  if (b.notify && typeof b.notify === 'object') cfg.notify = sanitizeConfig({ notify: { ...cfg.notify, ...b.notify } }, cfg).notify;
  broadcastPanels();
  persistSoon(); notifyMods();
  for (const [r, c] of panelClients) if (c.role !== 'broadcaster') sse(r, 'me', myLimits(c));
  res.json({ ok: true });
});
// ═════ Улюблене ═════
app.post('/api/favorites', requireUser, (req, res) => {
  const id = String((req.body || {}).id || '');
  const src = state.history.find(i => i.id === id) || (state.current && state.current.id === id ? state.current : null);
  if (!src) return res.status(404).json({ error: 'Не знайдено в історії' });
  if (cfg.favorites.some(f => f.id === src.id)) return res.json({ ok: true, already: true });
  if (cfg.favorites.length >= 100) return res.status(400).json({ error: 'Максимум 100 улюблених — видали щось старе' });
  const { shownAt, notify, ...clean } = src;
  cfg.favorites.unshift({ ...clean, fid: crypto.randomBytes(6).toString('hex'), savedBy: req.user.login, savedAt: Date.now() });
  persistSoon(); broadcastPanels();
  res.json({ ok: true });
});
app.delete('/api/favorites/:fid', requireUser, (req, res) => {
  const f = cfg.favorites.find(x => x.fid === req.params.fid);
  if (!f) return res.status(404).json({ error: 'Не знайдено' });
  if (req.user.role !== 'broadcaster' && f.savedBy !== req.user.login) return res.status(403).json({ error: 'Видалити може стрімер або той, хто зберіг' });
  cfg.favorites = cfg.favorites.filter(x => x !== f);
  persistSoon(); broadcastPanels();
  res.json({ ok: true });
});
app.post('/api/favorites/:fid/send', requireUser, (req, res) => {
  const f = cfg.favorites.find(x => x.fid === req.params.fid);
  if (!f) return res.status(404).json({ error: 'Не знайдено' });
  try { canSend(req.user); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { fid, savedBy, savedAt, ...item } = f;
  const fresh = { ...item, id: crypto.randomBytes(6).toString('hex'), by: { login: req.user.login, name: req.user.name, avatar: req.user.avatar }, createdAt: Date.now() };
  markSent(req.user);
  state.history.unshift(fresh); state.history = state.history.slice(0, 30);
  showItem(fresh);
  res.json({ ok: true });
});

// ═════ Пошук (проксі, щоб не було CORS і ключі не світились у браузері) ═════
const searchCache = new Map();
const lastSearch = new Map();
const KINDS = ['image', 'gif', 'youtube', 'music', 'clips'];
app.get('/api/search', requireUser, async (req, res) => {
  const kind = String(req.query.kind || '');
  const q = String(req.query.q || '').trim().slice(0, 120);
  const p = Math.min(9, Math.max(0, parseInt(req.query.p, 10) || 0));
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind' });
  if (!q && (kind === 'image' || kind === 'youtube' || kind === 'music')) return res.json({ results: [], more: false });
  const now = Date.now();
  const k2 = req.user.login + kind;
  if (now - (lastSearch.get(k2) || 0) < 400) return res.status(429).json({ error: 'Не так швидко 🙂' });
  lastSearch.set(k2, now);
  const key = [kind, cfg.filterRu ? 'f' : '', p, q.toLowerCase()].join('|');
  const hit = searchCache.get(key);
  if (hit && now - hit.t < 10 * 60 * 1000) return res.json(hit.v);

  const jobs = []; // [назва, promise]
  if (kind === 'image') { jobs.push(['Bing', search.bing(q, p, false)]); jobs.push(['DuckDuckGo', search.ddg(q, p, false)]); }
  if (kind === 'gif') {
    const gq = q || 'reaction';
    if (cfg.giphyKey) jobs.push(['GIPHY', search.giphy(q, p, cfg.giphyKey)]);
    jobs.push(['DuckDuckGo', search.ddg(gq + ' gif', p, true)]);
    jobs.push(['Bing', search.bing(gq, p, true)]);
  }
  if (kind === 'youtube') jobs.push(['YouTube', search.youtube(q, p)]);
  if (kind === 'music') {
    // YouTube Music (пісні); якщо не відповів — звичайний YouTube
    jobs.push(['YouTube Music', search.ytmusic(q, p).then(r => r.length || p ? r : search.youtube(q + ' audio', p))
      .catch(() => search.youtube(q + ' audio', p))]);
  }
  if (kind === 'clips') {
    jobs.push(['Twitch', (async () => {
      const H = await appHeaders();
      if (!H) throw new Error('Twitch-ключі не налаштовано');
      if (p > 0) return [];
      return search.filterClips(await search.channelClips(cfg.channel, H, twitchUsers), q);
    })()]);
  }
  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const ok = [], failed = [], lists = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') { ok.push(jobs[i][0]); lists.push(r.value); }
    else { failed.push(jobs[i][0]); console.warn('search', jobs[i][0], r.reason && r.reason.message); }
  });
  if (!ok.length) {
    const why = settled[0].reason && settled[0].reason.message;
    const msg = kind === 'clips' && why && why !== 'fetch failed' ? why : kind === 'clips' ? 'Немає зв\'язку з Twitch' : 'Пошук зараз не відповідає, спробуй ще раз';
    return res.status(502).json({ error: msg });
  }
  let results = search.interleave(lists);
  const rawCount = results.length;
  let hidden = 0;
  if (cfg.filterRu && kind !== 'clips') {
    const f = rufilter.filterResults(results, { urls: ['url', 'page'], texts: ['title', 'channel', 'user'] });
    results = f.results; hidden = f.hidden;
  }
  const v = { results: kind === 'clips' ? results : results.slice(0, 60), total: results.length, hidden, source: ok.join(' + '), failed, more: kind !== 'clips' && rawCount >= 15 };
  searchCache.set(key, { t: now, v });
  if (searchCache.size > 400) searchCache.delete(searchCache.keys().next().value);
  res.json(v);
});

app.post('/api/history/clear', requireUser, requireBroadcaster, (req, res) => { state.history = []; broadcastPanels(); res.json({ ok: true }); });

class UserError extends Error {}

const clipCache = new Map();
async function clipInfo(id) {
  if (clipCache.has(id)) return clipCache.get(id);
  try {
    const H = await appHeaders(); if (!H) return {};
    const r = await fetch('https://api.twitch.tv/helix/clips?id=' + encodeURIComponent(id), { headers: H, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return {};
    const c = (await r.json()).data[0];
    if (!c) return {};
    const v = { title: clamp(c.title, 140), author: c.broadcaster_name, duration: c.duration };
    clipCache.set(id, v);
    return v;
  } catch { return {}; }
}

const ytCache = new Map();
async function youtubeInfo(id) {
  if (ytCache.has(id)) return ytCache.get(id);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return {};
    const j = await r.json();
    const v = { title: clamp(j.title, 140), author: clamp(j.author_name, 100) };
    ytCache.set(id, v);
    return v;
  } catch { return {}; }
}

const SIZES = ['s', 'm', 'l', 'xl'];
const POSITIONS = ['auto', 'center', 'left', 'right', 'top', 'bottom', 'tl', 'tr', 'bl', 'br'];
const EFFECTS = ['auto', 'slide', 'pop', 'flip', 'zoom', 'reveal', 'glitch', 'none'];
const NO_END_EVENT_DEFAULT = 60;

async function buildItem(req) {
  const b = req.body || {};
  const type = String(b.type || '');
  const by = { login: req.user.login, name: req.user.name, avatar: req.user.avatar };
  let duration = b.duration === undefined || b.duration === '' ? NaN : Number(b.duration);
  const mediaType = type === 'video' || type === 'audio';
  if (!Number.isFinite(duration) || duration < 0) duration = mediaType ? 0 : cfg.defaultDuration;
  duration = Math.min(Math.round(duration), 600);
  if (!mediaType && duration === 0) duration = 0; // «поки не приберуть»

  const base = {
    id: crypto.randomBytes(6).toString('hex'), type, by,
    note: clamp(b.note, 500), duration,
    size: SIZES.includes(b.size) ? b.size : 'm',
    pos: POSITIONS.includes(b.pos) ? b.pos : 'auto',
    fx: EFFECTS.includes(b.fx) ? b.fx : 'auto',
    createdAt: Date.now(),
  };
  const mediaOpts = () => ({
    start: Math.min(parseTime(b.start), 86400),
    volume: Math.min(100, Math.max(0, Number.isFinite(+b.volume) ? +b.volume : 100)),
    muted: b.muted === '1' || b.muted === 'true',
  });

  if (type === 'image' || type === 'gif') {
    if (req.file) {
      if (!req.file.mimetype.startsWith('image/')) throw new UserError('Це не картинка');
      return { ...base, src: `/media/${req.file.filename}`, local: req.file.filename };
    }
    const url = safeHttpUrl(b.url);
    if (!url) throw new UserError('Додай файл або посилання на картинку');
    return { ...base, src: url };
  }

  if (type === 'video') {
    const o = mediaOpts();
    if (req.file) {
      if (!req.file.mimetype.startsWith('video/')) throw new UserError('Це не відео');
      return { ...base, ...o, src: `/media/${req.file.filename}`, local: req.file.filename };
    }
    const url = safeHttpUrl(b.url);
    if (!url) throw new UserError('Додай файл або посилання на відео');
    const embed = detectEmbed(url);
    if (embed) {
      if (o.start) embed.start = o.start;
      let dur = duration;
      if (!embed.endEvent && !dur) {
        // у кліпа Twitch знаємо точну тривалість — показуємо рівно стільки
        const ci = embed.kind === 'twitchclip' ? await clipInfo(embed.id) : {};
        dur = ci.duration ? Math.ceil(ci.duration) + 2 : NO_END_EVENT_DEFAULT;
      }
      return { ...base, ...o, embed, duration: dur };
    }
    return { ...base, ...o, src: url };
  }

  if (type === 'audio') {
    const o = mediaOpts();
    const title = clamp(b.title, 140);
    const artist = clamp(b.artist, 100);
    if (req.file) {
      if (!req.file.mimetype.startsWith('audio/')) throw new UserError('Це не аудіо');
      const name = clamp(Buffer.from(req.file.originalname || '', 'latin1').toString('utf8').replace(/\.[^.]+$/, ''), 140);
      return { ...base, ...o, title: title || name || 'Аудіо', artist, src: `/media/${req.file.filename}`, local: req.file.filename };
    }
    const url = safeHttpUrl(b.url);
    if (!url) throw new UserError('Додай файл або посилання на аудіо');
    const embed = detectEmbed(url);
    if (embed && embed.kind !== 'youtube') throw new UserError('Для аудіо підтримується YouTube або пряме посилання на файл');
    if (embed) {
      if (o.start) embed.start = o.start;
      const yt = title ? {} : await youtubeInfo(embed.id);
      return { ...base, ...o, title: title || yt.title || 'YouTube', artist: artist || (title ? '' : yt.author || ''), embed };
    }
    return { ...base, ...o, title: title || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Аудіо').slice(0, 140), artist, src: url };
  }

  if (type === 'text') {
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) throw new UserError('Текст порожній');
    return { ...base, title: clamp(b.title, 120), text };
  }

  if (type === 'article') {
    const url = safeHttpUrl(b.url);
    if (!url) throw new UserError('Потрібне посилання на статтю');
    let meta = {};
    try { meta = await fetchPreview(url); } catch (e) { console.warn('preview fail:', url, e.message); }
    const host = new URL(url).hostname.replace(/^www\./, '');
    return {
      ...base, url,
      title: clamp(b.title, 200) || meta.title || host,
      description: clamp(b.description, 400) || meta.description || '',
      image: meta.image || '',
      site: meta.site || host,
    };
  }
  throw new UserError('Невідомий тип');
}

// ═════════════════════ Оверлей ═════════════════════
function checkKey(req, res, next) {
  if (!cfg) return res.status(503).send('locked');
  const a = Buffer.from(String(req.query.key || '')), b = Buffer.from(cfg.overlayKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('Невірний key');
  next();
}
// сторінку оверлею віддаємо завжди — вона сама чекатиме, поки сервіс розблокують
app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/overlay/events', checkKey, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (state.current) sse(res, 'show', state.current);
  overlayClients.add(res); broadcastPanels();
  req.on('close', () => { overlayClients.delete(res); broadcastPanels(); });
});
app.post('/overlay/ended', checkKey, (req, res) => {
  const id = String((req.body || {}).id || '');
  if (state.current && state.current.id === id && !(state.current.duration > 0)) hideCurrent('ended');
  res.json({ ok: true });
});

// ═════════════════════ Сторінки ═════════════════════
app.get('/', (req, res) => {
  if (!cfg && isLocal(req)) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

setInterval(() => { for (const c of [...overlayClients, ...panelClients.keys()]) c.write(': ping\n\n'); }, 25000);
setInterval(() => {
  const keep = new Set([...state.history, ...(cfg ? cfg.favorites : [])].map(i => i.local).filter(Boolean));
  if (state.current && state.current.local) keep.add(state.current.local);
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (keep.has(f)) continue;
    const p = path.join(UPLOAD_DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(p); } catch {}
  }
}, 15 * 60 * 1000);

function openBrowser(url) {
  if (process.env.NO_OPEN === '1') return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🌻 Mod Drop запущено`);
  console.log(`   Налаштування: ${localUrl()}/setup`);
  // для сервера без екрана: MASTER_PASSWORD=... npm start
  if (process.env.MASTER_PASSWORD && store.exists()) {
    try {
      masterPassword = process.env.MASTER_PASSWORD;
      await applyConfig(sanitizeConfig(await store.load(masterPassword), DEFAULTS()), null);
      console.log('🔓 Розблоковано через MASTER_PASSWORD');
      const u = urls();
      console.log(`   Панель модерів:  ${u.panel}\n   Оверлей для OBS: ${u.overlayLocal}\n`);
      return;
    } catch (e) { masterPassword = null; console.error('❌ MASTER_PASSWORD не підійшов'); }
  }
  console.log(store.exists() ? '   🔒 Відкрий сторінку налаштувань і введи майстер-пароль\n' : '   ✨ Перший запуск — відкриваю майстер налаштування\n');
  openBrowser(`${localUrl()}/setup`);
});

process.on('SIGINT', async () => { await stopTunnel(); process.exit(0); });
