// Автооновлення з GitHub: порівнює дату останнього коміту з датою встановленої версії.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const OWNER = 'Mi-Miracle';
const REPO = 'Mod-Drop';
const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
// не чіпаємо дані користувача і запущений start.bat (cmd читає .bat з диска під час роботи)
const SKIP = new Set(['data', 'uploads', 'node_modules', '.git', 'start.bat']);

function readLocal(appDir) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, 'version.json'), 'utf8')); }
  catch { return { date: null, sha: null }; }
}

const GH_HEADERS = { 'User-Agent': 'ModDrop-Updater', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

async function fetchRemote() {
  const r1 = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(10000) });
  if (r1.status === 404) throw new Error('Репозиторій не знайдено або він приватний');
  if (r1.status === 403 || r1.status === 429) throw new Error(`GitHub відхилив запит (${r1.status}) — можливо, ліміт запитів, спробуй пізніше`);
  if (!r1.ok) throw new Error('GitHub: ' + r1.status);
  const repo = await r1.json();
  const branch = repo.default_branch || 'main';
  const r2 = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${encodeURIComponent(branch)}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(10000) });
  if (r2.status === 409) throw new Error('Репозиторій порожній — ще немає жодного коміту');
  if (!r2.ok) throw new Error('GitHub: ' + r2.status);
  const c = await r2.json();
  return {
    sha: c.sha, branch,
    date: (c.commit && (c.commit.committer || c.commit.author) || {}).date || null,
    message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 200),
    url: c.html_url || REPO_URL,
  };
}

function isNewer(remote, local) {
  if (!remote || !remote.date) return false;
  if (local.sha && remote.sha === local.sha) return false;
  if (!local.date) return true;
  return new Date(remote.date).getTime() > new Date(local.date).getTime();
}

async function download(sha, dest) {
  const r = await fetch(`https://codeload.github.com/${OWNER}/${REPO}/zip/${sha}`, { headers: { 'User-Agent': 'ModDrop-Updater' }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('Не вдалося завантажити архів: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error('Архів завеликий');
  fs.writeFileSync(dest, buf);
}

// шукає папку з проєктом усередині архіву (server.js + package.json)
function findRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
  if (depth >= 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP.has(e.name)) { const r = findRoot(path.join(dir, e.name), depth + 1); if (r) return r; }
  }
  return null;
}

function copyTree(src, dst, skipTop) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTop && SKIP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d, false); }
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

const deps = p => { try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return JSON.stringify(j.dependencies || {}); } catch { return ''; } };

// Встановлює оновлення з zip-файлу. Повертає { depsChanged }.
function installFromZip(zipPath, appDir, log = () => {}) {
  const work = path.join(appDir, 'data', 'update_tmp');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const zip = new AdmZip(zipPath);
  // захист від «zip slip»: усі шляхи мають лишатися всередині work
  for (const entry of zip.getEntries()) {
    const target = path.resolve(work, entry.entryName);
    if (!target.startsWith(path.resolve(work) + path.sep)) throw new Error('Небезпечний шлях в архіві: ' + entry.entryName);
  }
  zip.extractAllTo(work, true);
  const root = findRoot(work);
  if (!root) throw new Error('В архіві з GitHub не знайдено server.js — перевір, що файли проєкту лежать у репозиторії');
  if (!fs.existsSync(path.join(root, 'public', 'panel.html'))) throw new Error('Архів не схожий на Mod Drop (нема public/panel.html)');

  // резервна копія поточної версії
  const backup = path.join(appDir, 'data', 'backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true });
  copyTree(appDir, backup, true);
  log('backup → ' + backup);
  // лишаємо дві останні копії
  const backups = fs.readdirSync(path.join(appDir, 'data')).filter(n => n.startsWith('backup-')).sort();
  for (const old of backups.slice(0, -2)) fs.rmSync(path.join(appDir, 'data', old), { recursive: true, force: true });

  const depsChanged = deps(path.join(root, 'package.json')) !== deps(path.join(appDir, 'package.json'));
  copyTree(root, appDir, true);
  // якщо в новій версії змінився start.bat — кладемо поруч, щоб не зламати запущений
  const newBat = path.join(root, 'start.bat');
  if (fs.existsSync(newBat)) {
    const cur = path.join(appDir, 'start.bat');
    if (!fs.existsSync(cur) || fs.readFileSync(newBat, 'utf8') !== fs.readFileSync(cur, 'utf8')) fs.copyFileSync(newBat, path.join(appDir, 'start.bat.new'));
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { depsChanged };
}

function npmInstall(appDir) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const p = spawn(cmd, ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: appDir, shell: process.platform === 'win32', stdio: 'inherit' });
    const t = setTimeout(() => { p.kill(); reject(new Error('npm install завис')); }, 5 * 60 * 1000);
    p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('npm install завершився з кодом ' + code)); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

module.exports = { OWNER, REPO, REPO_URL, readLocal, fetchRemote, isNewer, download, installFromZip, npmInstall };
