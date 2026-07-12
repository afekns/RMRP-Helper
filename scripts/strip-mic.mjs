/**
 * Remove remaining microphone feature code from main.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = path.join(root, 'main.js');
let s = fs.readFileSync(mainPath, 'utf8');

const replacements = [
  [
    /\/\/ Страницы грузятся[\s\S]*?console\.warn\('\[mic\] secure-origin switch failed:', err\.message\);\r?\n\}\r?\n\r?\n/,
    '',
  ],
  [
    /\/\*\* Скрытое окно Web Audio:[\s\S]*?micLabel: '',\r?\n\};\r?\n\r?\n/,
    '',
  ],
  [
    /\r?\n\s*\/\/ Фоновый mic-engine[\s\S]*?console\.warn\('\[mic-engine\] init:', err\.message\);\r?\n\s*\}\r?\n/,
    '\n',
  ],
  [
    /ipcMain\.handle\('enumerate-audio-input-devices'[\s\S]*?(?=ipcMain\.handle\('get-ghost-mode')/,
    '',
  ],
  [
    /\/\/ Авто-разрешение микрофона[\s\S]*?\/\* старые версии Electron без setDevicePermissionHandler \*\/\r?\n\s*\}/,
    `// Security: deny media/mic/camera
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            if (permission === 'clipboard-sanitized-write') {
                callback(true);
                return;
            }
            callback(false);
        });
        session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
            return permission === 'clipboard-sanitized-write';
        });
        try {
            session.defaultSession.setDevicePermissionHandler(() => false);
        } catch {
            /* old Electron */
        }`,
  ],
  [/const micDriver = require\('\.\/mic-driver'\);\r?\n?/g, ''],
  [/const audioDevices = require\('\.\/audio-devices'\);\r?\n?/g, ''],
  [/\n\s*store\.delete\('rmrp_microphone_settings'\);/g, ''],
];

for (const [re, rep] of replacements) {
  const before = s.length;
  s = s.replace(re, rep);
  console.log(String(re).slice(0, 50), 'delta', s.length - before);
}

fs.writeFileSync(mainPath, s);
const left = s.match(
  /micDriver|audioDevices|microphone|mic-engine|audio-engine|getUserMedia|rmrp_microphone|micLabel|ensureMicEngine|enumerate-audio|mic-driver|Микрофон/gi,
) || [];
console.log('leftovers unique:', [...new Set(left)]);
