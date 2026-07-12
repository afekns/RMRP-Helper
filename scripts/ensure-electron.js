const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');
const distExe = path.join(electronDir, 'dist', 'electron.exe');
const fallbackDir = path.join(__dirname, '..', '..', 'RMRP Helper - 2.0', 'node_modules', 'electron');

function copyFromFallback() {
  if (!fs.existsSync(path.join(fallbackDir, 'dist', 'electron.exe'))) {
    return false;
  }
  fs.mkdirSync(path.join(electronDir, 'dist'), { recursive: true });
  fs.cpSync(path.join(fallbackDir, 'dist'), path.join(electronDir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(fallbackDir, 'path.txt'), pathFile);
  console.log('[ensure-electron] Скопирован бинарник из RMRP Helper - 2.0');
  return true;
}

if (fs.existsSync(distExe) && fs.existsSync(pathFile)) {
  process.exit(0);
}

console.log('[ensure-electron] Бинарник Electron не найден, пробуем восстановить...');

try {
  execSync('node install.js', { cwd: electronDir, stdio: 'inherit' });
} catch (err) {
  console.warn('[ensure-electron] install.js не сработал:', err.message);
}

if (fs.existsSync(distExe)) {
  process.exit(0);
}

if (copyFromFallback()) {
  process.exit(0);
}

console.error('[ensure-electron] Не удалось восстановить Electron. Выполните:');
console.error('  node node_modules/electron/install.js');
console.error('  или скопируйте dist + path.txt из RMRP Helper - 2.0\\node_modules\\electron\\');
process.exit(1);