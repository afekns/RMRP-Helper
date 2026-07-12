/**
 * Генерирует integrity-manifest.json — эталон sha1 для стартовой проверки клиента.
 * Публикуется в GitHub; клиент качает через raw.githubusercontent.com (без api.github.com).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const TRACKED_EXACT = new Set([
  'main.js', 'preload.js', 'binder-runtime.js', 'binder-send.ps1',
]);
const TRACKED_PREFIXES = ['page/', 'img/', 'sounds/', 'build/icons/'];

const SKIP = new Set([
  'node_modules', 'release', '.git', 'logs.txt', '.env', 'driver-signed.zip',
  'package-lock.json', 'integrity-manifest.json',
]);

function isTracked(relPosix) {
  if (TRACKED_EXACT.has(relPosix)) return true;
  return TRACKED_PREFIXES.some((p) => relPosix.startsWith(p));
}

function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

function walk(dir, relBase = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    const relPosix = rel.replace(/\\/g, '/');
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, relPosix));
    } else if (isTracked(relPosix)) {
      out.push({ path: relPosix, sha: gitBlobSha1(fs.readFileSync(full)) });
    }
  }
  return out;
}

const files = Object.fromEntries(walk(ROOT).map((e) => [e.path, e.sha]));
let version = '0.0.0';
try {
  version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version;
} catch { /* ignore */ }

const manifest = {
  version,
  branch: 'main',
  generatedAt: new Date().toISOString(),
  files,
};

const outPath = path.join(ROOT, 'integrity-manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`integrity-manifest.json: ${Object.keys(files).length} files, v${version}`);