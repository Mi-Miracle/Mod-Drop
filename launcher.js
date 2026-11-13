// Запускає server.js і перезапускає його після оновлення (код виходу 42).
const { spawn } = require('child_process');
const path = require('path');
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
process.on('SIGINT', () => { if (child) child.kill('SIGINT'); });
run();
