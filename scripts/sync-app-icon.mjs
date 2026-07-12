/**
 * Copy canonical app-icon.png (red mountain) into client-updated and rebuild .ico
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source =
  process.env.RMRP_APP_ICON_SOURCE ||
  path.join(root, '..', 'RMRP Helper - Готовая версия', 'app-icon.png');

if (!fs.existsSync(source)) {
  console.error('Source icon not found:', source);
  process.exit(1);
}

const buf = fs.readFileSync(source);
for (const name of ['app-icon.png', 'tray-icon.png']) {
  fs.writeFileSync(path.join(root, name), buf);
  console.log('Wrote', name);
}

const traySrc = path.join(path.dirname(source), 'tray-icon.png');
if (fs.existsSync(traySrc)) {
  fs.writeFileSync(path.join(root, 'tray-icon.png'), fs.readFileSync(traySrc));
  console.log('Wrote tray-icon.png (dedicated)');
}

execSync('npm run build:icons', { cwd: root, stdio: 'inherit' });
console.log('Icons rebuilt (icon.ico + sizes)');