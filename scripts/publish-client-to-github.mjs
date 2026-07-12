/**
 * Publish client-updated sources to https://github.com/afekns/RMRP-Helper
 *
 *   $env:GITHUB_TOKEN='ghp_...'; node scripts/publish-client-to-github.mjs
 *
 * Requires: git in PATH, token with repo scope.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.join(__dirname, '..');
const REPO = 'afekns/RMRP-Helper';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const EXCLUDE = new Set([
  'node_modules',
  'release',
  'logs.txt',
  '.git',
  'driver-signed.zip',
  'package-lock.json',
  'data',
  'files',
]);

function shouldSkipFile(name) {
  if (EXCLUDE.has(name)) return true;
  if (name.endsWith('.log')) return true;
  if (name === '.env') return true;
  if (name.startsWith('.env.') && name !== '.env.example') return true;
  return false;
}

function findGit() {
  const candidates = [
    'git',
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files (x86)\\Git\\bin\\git.exe',
  ];
  for (const g of candidates) {
    try {
      const r = spawnSync(g, ['--version'], { encoding: 'utf8' });
      if (r.status === 0) return g;
    } catch { /* */ }
  }
  return null;
}

function copyFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (shouldSkipFile(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyFiltered(from, to);
    else fs.copyFileSync(from, to);
  }
}

function run(git, args, cwd) {
  console.log('>', git, args.join(' '));
  execSync(`"${git}" ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
}

const git = findGit();
if (!git) {
  console.error('Git not found. Install Git for Windows and re-run.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('Set GITHUB_TOKEN (or GH_TOKEN) with repo write access.');
  process.exit(1);
}

// Эталон sha1 для стартовой проверки клиента (raw.githubusercontent.com)
const genManifest = path.join(CLIENT_ROOT, 'scripts', 'generate-integrity-manifest.mjs');
if (fs.existsSync(genManifest)) {
  console.log('Generating integrity-manifest.json…');
  execSync(`node "${genManifest}"`, { cwd: CLIENT_ROOT, stdio: 'inherit' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmrp-client-publish-'));
console.log('Staging in', tmp);
copyFiltered(CLIENT_ROOT, tmp);

// Ensure .gitignore for the public repo
fs.writeFileSync(
  path.join(tmp, '.gitignore'),
  [
    'node_modules/',
    'release/',
    '.env',
    '.env.local',
    '.env.*.local',
    '!.env.example',
    '*.log',
    'logs.txt',
    'driver-signed.zip',
    'package-lock.json',
    '.DS_Store',
    'Thumbs.db',
  ].join('\n') + '\n',
);

const remote = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
run(git, ['init'], tmp);
run(git, ['checkout', '-B', BRANCH], tmp);
run(git, ['config', 'user.email', process.env.GIT_USER_EMAIL || 'bot@rmrp-helper.local'], tmp);
run(git, ['config', 'user.name', process.env.GIT_USER_NAME || 'RMRP Helper Publisher'], tmp);
run(git, ['add', '-A'], tmp);
try {
  run(git, ['commit', '-m', `chore: publish client ${new Date().toISOString()}`], tmp);
} catch {
  console.log('Nothing to commit (tree clean) — force-pushing current tree');
}
run(git, ['remote', 'add', 'origin', remote], tmp);
run(git, ['push', '-u', 'origin', BRANCH, '--force'], tmp);

console.log('Published to https://github.com/' + REPO);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* */ }
