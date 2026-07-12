#!/usr/bin/env node
/**
 * RMRP Helper — умный запускатор.
 * Проверяет зависимости, Electron, иконки и доступность сервера, затем стартует приложение.
 *
 * Использование:
 *   node scripts/launcher.mjs          — с логом в консоли
 *   node scripts/launcher.mjs --silent — без вывода (для .vbs)
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SILENT = process.argv.includes('--silent');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  accent: '\x1b[38;5;203m',
};

function log(msg, tone = 'dim') {
  if (SILENT) return;
  const color = C[tone] || C.dim;
  console.log(`${color}${msg}${C.reset}`);
}

function logStep(label, state) {
  if (SILENT) return;
  const icon = state === 'ok' ? `${C.green}✓` : state === 'warn' ? `${C.yellow}!` : state === 'fail' ? `${C.red}✗` : `${C.dim}…`;
  console.log(`  ${icon}${C.reset} ${label}`);
}

function banner() {
  if (SILENT) return;
  console.log('');
  console.log(`${C.accent}${C.bold}  RMRP Helper${C.reset}`);
  console.log(`${C.dim}  ─────────────────────────${C.reset}`);
  console.log('');
}

function readEnvServerUrl() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return 'http://localhost:3000';
  const text = fs.readFileSync(envPath, 'utf8');
  const match = text.match(/^SERVER_URL=(.+)$/m);
  return match ? match[1].trim() : 'http://localhost:3000';
}

function pingServer(baseUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const url = new URL(baseUrl.replace(/\/$/, '') + '/auth/telegram/ping');
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: SILENT ? 'ignore' : 'inherit',
      shell: process.platform === 'win32',
      windowsHide: SILENT,
      ...opts,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

function resolveElectronExe() {
  const pathFile = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
  if (fs.existsSync(pathFile)) {
    const rel = fs.readFileSync(pathFile, 'utf8').trim();
    const exe = path.join(ROOT, 'node_modules', 'electron', rel);
    if (fs.existsSync(exe)) return exe;
  }
  const direct = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(direct)) return direct;
  return null;
}

async function ensureNodeModules() {
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(path.join(nm, 'electron', 'package.json'))) {
    logStep('Зависимости', 'ok');
    return;
  }
  logStep('Установка зависимостей (npm install)…', 'run');
  await run('npm', ['install', '--no-fund', '--no-audit']);
  logStep('Зависимости установлены', 'ok');
}

async function ensureElectronBinary() {
  if (resolveElectronExe()) {
    logStep('Electron', 'ok');
    return;
  }
  logStep('Восстановление Electron…', 'run');
  execSync('node scripts/ensure-electron.js', { cwd: ROOT, stdio: SILENT ? 'ignore' : 'inherit' });
  if (!resolveElectronExe()) throw new Error('Electron не найден. Запустите: npm install');
  logStep('Electron', 'ok');
}

async function ensureIcons() {
  const ico = path.join(ROOT, 'build', 'icons', 'icon.ico');
  if (fs.existsSync(ico)) {
    logStep('Иконки', 'ok');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'app-icon.png'))) {
    logStep('Иконки (app-icon.png не найден)', 'warn');
    return;
  }
  logStep('Сборка иконок…', 'run');
  try {
    execSync('npm run build:icons', { cwd: ROOT, stdio: SILENT ? 'ignore' : 'inherit' });
    logStep('Иконки', 'ok');
  } catch {
    logStep('Иконки (пропущено)', 'warn');
  }
}

async function checkServer() {
  const serverUrl = readEnvServerUrl();
  log(`${C.dim}  Сервер: ${serverUrl}${C.reset}`);
  const online = await pingServer(serverUrl);
  if (online) {
    logStep('Сервер доступен', 'ok');
  } else {
    logStep('Сервер недоступен — приложение откроет экран «Нет сети»', 'warn');
  }
}

function launchApp() {
  const electronExe = resolveElectronExe();
  if (!electronExe) throw new Error('Не удалось найти electron.exe');

  logStep('Запуск RMRP Helper…', 'run');
  if (!SILENT) log('');

  const child = spawn(electronExe, ['.'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  if (!SILENT) {
    log(`${C.green}  Готово. Окно приложения открывается…${C.reset}`, 'green');
    log('');
  }
}

async function main() {
  banner();
  try {
    await ensureNodeModules();
    await ensureElectronBinary();
    await ensureIcons();
    await checkServer();
    launchApp();
    process.exit(0);
  } catch (err) {
    const msg = err?.message || String(err);
    if (SILENT) {
      try {
        const { execSync: exec } = await import('child_process');
        exec(
          `mshta "javascript:var sh=new ActiveXObject('WScript.Shell');sh.Popup('RMRP Helper — ошибка запуска:\\n\\n${msg.replace(/'/g, "\\'")}',0,'RMRP Helper',16);close()"`,
          { stdio: 'ignore', windowsHide: true },
        );
      } catch {
        /* ignore */
      }
    } else {
      console.error(`\n${C.red}${C.bold}  Ошибка: ${msg}${C.reset}\n`);
      console.log(`${C.dim}  Нажмите любую клавишу…${C.reset}`);
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', () => process.exit(1));
      } catch {
        setTimeout(() => process.exit(1), 15000);
      }
      return;
    }
    process.exit(1);
  }
}

main();