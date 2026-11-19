// Запускає server.js:
//  1) перед стартом перевіряє GitHub і сам ставить нову версію (автооновлення);
//  2) перезапускає сервер після оновлення з налаштувань (код виходу 42).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, 'data');
const SETTINGS = path.join(DATA, 'launcher.json');   // не секретні налаштування запуску (без шифрування)
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ': час вийшов')), ms))]);

async function autoUpdate() {
  if (process.env.MODDROP_NO_AUTOUPDATE === '1' || readSettings().autoUpdate === false) {
    console.log('⏭  Автооновлення вимкнено в налаштуваннях');
    return;
  }
  let updater;
  try { updater = require('./lib/updater'); } catch { return; }
  try {
    console.log('🔄 Перевіряю оновлення на GitHub…');
    const local = updater.readLocal(__dirname);
    const remote = await withTimeout(updater.fetchRemote(), 12000, 'GitHub');
    if (!updater.isNewer(remote, local)) { console.log('✅ У тебе остання версія'); return; }
    const when = remote.date ? new Date(remote.date).toLocaleString('uk-UA') : '';
    console.log(`⬇️  Знайдено нову версію ${remote.sha.slice(0, 7)} (${when}): ${remote.message || ''}`);
    fs.mkdirSync(DATA, { recursive: true });
    const zip = path.join(DATA, 'update.zip');
    await withTimeout(updater.download(remote.sha, zip), 120000, 'Завантаження');
    console.log('📦 Встановлюю…');
    const { depsChanged } = updater.installFromZip(zip, __dirname, m => console.log('   ', m));
    fs.rmSync(zip, { force: true });
    if (depsChanged) { console.log('📚 Оновлюю залежності (npm install)…'); await updater.npmInstall(__dirname); }
    fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify({ date: remote.date, sha: remote.sha, branch: remote.branch }, null, 2));
    console.log('✅ Оновлено до нової версії!\n');
  } catch (e) {
    // без інтернету чи при збої просто запускаємо поточну версію
    console.log(`⚠️  Автооновлення не вдалося (${e.message}) — запускаю поточну версію\n`);
  }
}

let restarted = false, child = null;
function run() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, MODDROP_LAUNCHER: '1', ...(restarted ? { NO_OPEN: '1' } : {}) },
  });
  child.on('exit', code => {
    if (code === 42) { console.log('\n♻️  Оновлення встановлено — перезапускаю…\n'); restarted = true; setTimeout(run, 800); }
    else process.exit(code ?? 0);
  });
}
process.on('SIGINT', () => { if (child) child.kill('SIGINT'); else process.exit(0); });
autoUpdate().finally(run);
