const { app, BrowserWindow, BrowserView, globalShortcut, Tray, Menu, nativeImage, ipcMain, screen, shell, clipboard, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Store = require('electron-store');
const binderRuntime = require('./binder-runtime');
require('dotenv').config({ path: path.join(__dirname, '.env') });

app.commandLine.appendSwitch('disk-cache-size', '134217728');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ==================== ПУТИ: ТОЛЬКО ПАПКА УСТАНОВКИ (НЕ %APPDATA%) ====================
function getInstallRoot() {
    if (app.isPackaged) {
        return path.dirname(process.execPath);
    }
    return __dirname;
}

function getLocalDataDir() {
    return path.join(getInstallRoot(), 'data');
}

function configureInstallPaths() {
    const dataDir = getLocalDataDir();
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        app.setPath('userData', dataDir);
        app.setPath('sessionData', dataDir);
        const cacheDir = path.join(dataDir, 'cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        app.setPath('cache', cacheDir);
    } catch (err) {
        console.error('configureInstallPaths:', err.message);
    }
}

configureInstallPaths();

// ==================== АДРЕС СЕРВЕРА СТРАНИЦ ====================
// Все экраны, кроме splash/offline (они локальные — нужны ДО того, как известно,
// доступен ли сервер), теперь отдаются сервером по белому списку маршрутов
// (см. PagesController в server/src/modules/pages). В клиентской сборке эти .html
// больше не хранятся — их нельзя открыть/подменить локально из папки приложения.
// Публичный API (HTTPS). Для локальной разработки задайте SERVER_URL в .env (см. .env.example).
const DEFAULT_SERVER_URL = 'https://37-220-86-102.sslip.io';
const SERVER_URL_STORE_KEY = 'rmrp_server_url';
/** Старые адреса VPS — пробуем, если в сборке или .env остался мёртвый хост */
const LEGACY_SERVER_URLS = [
    'https://130.49.213.14.sslip.io',
    'http://130.49.213.14:3000',
];

// Единственные страницы, которые реально существуют в клиентской сборке.
const LOCAL_PAGES = {
    splash: () => resolveAppReadPath('page/splash.html'),
    offline: () => resolveAppReadPath('page/offline.html'),
};

// Имя приложения на уровне Electron (About-панель, некоторые системные диалоги) + AppUserModelID
// для Windows (группировка окон в панели задач и корректное имя во всплывающих уведомлениях).
// ВАЖНО: ни то, ни другое НЕ переименовывает сам процесс в Диспетчере задач — там видно имя
// физического exe-файла, а это уже вопрос упаковки через electron-builder (см. package.json → "build").
app.setName('RMRP Helper');
if (process.platform === 'win32') {
    app.setAppUserModelId('com.rmrphelper.app');
}

// Только один экземпляр приложения — повторный запуск (npm start / ярлык) фокусирует уже открытое окно.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        } else if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.show();
            splashWindow.focus();
        }
    });
}

const store = new Store();
const AUTH_REFRESH_KEY = 'rmrp_auth_refresh';

function normalizeServerUrl(url) {
    return String(url || '').trim().replace(/\/$/, '');
}

function buildServerUrlCandidates() {
    const seen = new Set();
    const list = [];
    const add = (u) => {
        const v = normalizeServerUrl(u);
        if (v && !seen.has(v)) {
            seen.add(v);
            list.push(v);
        }
    };
    add(process.env.SERVER_URL);
    try { add(store.get(SERVER_URL_STORE_KEY)); } catch { /* ignore */ }
    add(DEFAULT_SERVER_URL);
    for (const u of LEGACY_SERVER_URLS) add(u);
    return list;
}

let SERVER_URL = normalizeServerUrl(
    process.env.SERVER_URL || store.get(SERVER_URL_STORE_KEY) || DEFAULT_SERVER_URL,
) || DEFAULT_SERVER_URL;

function adoptServerUrl(url) {
    const next = normalizeServerUrl(url);
    if (!next || next === SERVER_URL) return;
    SERVER_URL = next;
    try { store.set(SERVER_URL_STORE_KEY, next); } catch { /* ignore */ }
}

// main.js лежит в app.asar.unpacked — иконки тоже должны быть рядом (см. asarUnpack в package.json).
function resolveResourcePath(...parts) {
    const rel = path.join(...parts);
    const besideMain = path.join(__dirname, rel);
    if (fs.existsSync(besideMain)) return besideMain;
    try {
        const inAsar = path.join(app.getAppPath(), rel);
        if (fs.existsSync(inAsar)) return inAsar;
    } catch {
        /* app not ready */
    }
    return besideMain;
}

function getAppIconPath() {
    return resolveResourcePath('app-icon.png');
}

function getTrayIconPath() {
    return resolveResourcePath('tray-icon.png');
}

function getWindowIcon() {
    const candidates = [
        path.join(process.resourcesPath, 'app.ico'),
        resolveResourcePath('build', 'icons', 'icon.ico'),
        getAppIconPath(),
    ];
    for (const candidate of candidates) {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const img = nativeImage.createFromPath(candidate);
        if (!img.isEmpty()) return img;
    }
    return undefined;
}

function applyWindowIcon(win) {
    if (!win || win.isDestroyed()) return;
    const icon = getWindowIcon();
    if (icon) win.setIcon(icon);
}

function getTrayIconImage() {
    const trayPng = getTrayIconPath();
    if (fs.existsSync(trayPng)) {
        const img = nativeImage.createFromPath(trayPng);
        if (!img.isEmpty()) return img;
    }
    const appPng = getAppIconPath();
    if (fs.existsSync(appPng)) {
        const img = nativeImage.createFromPath(appPng);
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    }
    const winIcon = getWindowIcon();
    if (winIcon) return winIcon.resize({ width: 16, height: 16 });
    return null;
}
let accessToken = null;
let mainWindow = null;
let splashWindow = null;
let tray = null;
let friendsWindow = null;
let pinnedNoteWindows = new Map(); // Хранилище для окон закрепленных заметок

/** Кэш вкладок (BrowserView) — мгновенное переключение без перезагрузки страницы */
const pageViewCache = new Map();
let activePageView = null;
let activePageRoute = null;
const PREFETCH_ROUTES = ['notein', 'online', 'binder', 'setting'];
const PREFETCH_START_DELAY_MS = 5000;
const PREFETCH_STEP_MS = 1400;
const PREFETCH_MAX_CONCURRENT = 1;
let prefetchQueue = [];
let prefetchActive = 0;

// ==================== ГЕОМЕТРИЯ ОКОН (ДОЛЯ ОТ ПЛОЩАДИ ЭКРАНА) ====================
// Окно загрузки (splash) занимает ровно 9.69% площади экрана, основное окно — 56.71%.
// Чтобы окно не было ни слишком узким, ни слишком широким, сохраняем соотношение сторон
// текущего монитора пользователя и подбираем ширину/высоту так, чтобы width*height было
// точно равно нужной доле от screenWidth*screenHeight.
const SPLASH_AREA_FRACTION = 0.0969;
const MAIN_AREA_FRACTION = 0.5671;
const MAIN_WINDOW_SIZE_KEY = 'rmrp_main_window_size';
/** 'fixed' — менять размер только через «Изменить»+«Сохранить»; 'floating' — тянуть края всегда */
const MAIN_WINDOW_SIZE_MODE_KEY = 'rmrp_main_window_size_mode';
const MIN_MAIN_W = 720;
const MIN_MAIN_H = 480;

function getWindowSizeForAreaFraction(fraction) {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const screenArea = screenW * screenH;
    const targetArea = screenArea * fraction;
    const aspectRatio = screenW / screenH;

    const height = Math.round(Math.sqrt(targetArea / aspectRatio));
    const width = Math.round(height * aspectRatio);
    return { width, height };
}

function clampMainWindowSize(width, height) {
    const { width: maxW, height: maxH } = screen.getPrimaryDisplay().workAreaSize;
    const w = Math.min(maxW, Math.max(MIN_MAIN_W, Math.round(Number(width) || 0)));
    const h = Math.min(maxH, Math.max(MIN_MAIN_H, Math.round(Number(height) || 0)));
    return { width: w, height: h };
}

/** 'fixed' | 'floating' */
function getWindowSizeMode() {
    const m = store.get(MAIN_WINDOW_SIZE_MODE_KEY);
    return m === 'floating' ? 'floating' : 'fixed';
}

function setWindowSizeMode(mode) {
    const next = mode === 'floating' ? 'floating' : 'fixed';
    store.set(MAIN_WINDOW_SIZE_MODE_KEY, next);
    return next;
}

/** Default main window size: last saved (or last session) or ~56.71% screen area. */
function getMainWindowSize() {
    const saved = store.get(MAIN_WINDOW_SIZE_KEY);
    if (saved && Number(saved.width) > 0 && Number(saved.height) > 0) {
        return clampMainWindowSize(saved.width, saved.height);
    }
    const frac = getWindowSizeForAreaFraction(MAIN_AREA_FRACTION);
    return clampMainWindowSize(frac.width, frac.height);
}

function getSavedMainWindowSize() {
    const saved = store.get(MAIN_WINDOW_SIZE_KEY);
    if (saved && Number(saved.width) > 0 && Number(saved.height) > 0) {
        return clampMainWindowSize(saved.width, saved.height);
    }
    return null;
}

function saveMainWindowSize(width, height) {
    const size = clampMainWindowSize(width, height);
    store.set(MAIN_WINDOW_SIZE_KEY, size);
    return size;
}

/** Persist current main window size (before quit / floating resize). */
function persistMainWindowSizeFromWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try {
        const b = mainWindow.getBounds();
        return saveMainWindowSize(b.width, b.height);
    } catch {
        return null;
    }
}

function applyWindowSizeModeToMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return getWindowSizeMode();
    const mode = getWindowSizeMode();
    // floating: always resizable; fixed: only during explicit resize session
    const allowResize = mode === 'floating' || !!windowResizeSession;
    mainWindow.setMinimumSize(MIN_MAIN_W, MIN_MAIN_H);
    mainWindow.setResizable(allowResize);
    return mode;
}

let windowSizeSaveTimer = null;
function schedulePersistMainWindowSize() {
    if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
    windowSizeSaveTimer = setTimeout(() => {
        windowSizeSaveTimer = null;
        if (getWindowSizeMode() === 'floating' || !windowResizeSession) {
            // floating: always; fixed outside resize session: keep last (no-op usually)
            if (getWindowSizeMode() === 'floating') {
                persistMainWindowSizeFromWindow();
            }
        }
    }, 400);
}

/** Temporary state while user resizes from Settings. */
let windowResizeSession = null;

/** Пока true — не трогаем zoom/resize-store (иначе окно дёргается на Windows). */
let mainWindowDragActive = false;

// ==================== ПРОВЕРКА ИНТЕРНЕТ-СОЕДИНЕНИЯ ====================
// Несколько fallback-хостов: api.github.com иногда режется антивирусом/DNS.
function checkInternetConnectivity(timeoutMs = 8000) {
    const hosts = [
        'https://api.github.com',
        'https://www.cloudflare.com/cdn-cgi/trace',
        'https://1.1.1.1',
        'https://raw.githubusercontent.com',
    ];
    return new Promise((resolve) => {
        let left = hosts.length;
        let ok = false;
        const done = (v) => {
            if (v) ok = true;
            left -= 1;
            if (left <= 0 || ok) resolve(ok);
        };
        for (const url of hosts) {
            try {
                const req = https.get(url, {
                    headers: { 'User-Agent': 'RMRP-Helper-NetCheck' },
                    timeout: timeoutMs,
                    rejectUnauthorized: true,
                }, (res) => {
                    res.resume();
                    done(res.statusCode > 0 && res.statusCode < 600);
                });
                req.on('timeout', () => { req.destroy(); done(false); });
                req.on('error', () => done(false));
            } catch {
                done(false);
            }
        }
    });
}

function checkServerConnectivityOnce(baseUrl, timeoutMs = 10000) {
    return new Promise((resolve) => {
        try {
            const base = normalizeServerUrl(baseUrl);
            if (!base) {
                resolve(false);
                return;
            }
            const paths = ['/health', '/auth/telegram/ping', '/main'];
            let i = 0;
            const tryNext = () => {
                if (i >= paths.length) {
                    resolve(false);
                    return;
                }
                const pathPart = paths[i++];
                try {
                    const parsed = new URL(`${base}${pathPart}`);
                    const lib = parsed.protocol === 'https:' ? https : http;
                    const opts = {
                        hostname: parsed.hostname,
                        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                        path: parsed.pathname + parsed.search,
                        method: 'GET',
                        timeout: timeoutMs,
                        headers: {
                            'User-Agent': 'RMRP-Helper-ServerCheck',
                            Host: parsed.host,
                        },
                        rejectUnauthorized: false,
                    };
                    if (parsed.protocol === 'https:') opts.servername = parsed.hostname;
                    const req = lib.request(opts, (res) => {
                        res.resume();
                        if (res.statusCode >= 200 && res.statusCode < 500) resolve(true);
                        else tryNext();
                    });
                    req.on('timeout', () => { req.destroy(); tryNext(); });
                    req.on('error', () => tryNext());
                    req.end();
                } catch {
                    tryNext();
                }
            };
            tryNext();
        } catch {
            resolve(false);
        }
    });
}

async function checkServerConnectivity(timeoutMs = 10000, maxRounds = 2) {
    const bases = buildServerUrlCandidates();
    for (let round = 1; round <= maxRounds; round++) {
        for (const base of bases) {
            const ok = await checkServerConnectivityOnce(base, timeoutMs);
            if (ok) {
                adoptServerUrl(base);
                return true;
            }
        }
        if (round < maxRounds) await wait(700 * round);
    }
    return false;
}

// ==================== СТАРТОВАЯ ПРОВЕРКА: APPDATA + ЦЕЛОСТНОСТЬ ФАЙЛОВ С VPS ====================
// Эталон и загрузка — только с API VPS (SERVER_URL/client-files/). При расхождении sha256
// файлы докачиваются с сервера. GitHub для целостности не используется.
const INTEGRITY_CORE_FILES = new Set(['main.js', 'preload.js', 'binder-runtime.js', 'binder-send.ps1']);
const INTEGRITY_TRACKED_PATHS = [
    ...INTEGRITY_CORE_FILES,
    'page/', 'img/', 'sounds/', 'build/icons/',
];
/** Legacy env flag — запуск больше не блокируется из-за целостности. */
const INTEGRITY_STRICT = process.env.INTEGRITY_STRICT !== '0';
const INTEGRITY_CACHE_KEY = 'rmrp_integrity_cache';
const INTEGRITY_HTTP_TIMEOUT_MS = 8000;

/** Запасной каталог рядом с exe, если resources только для чтения. */
const INSTALL_FILES_SUBDIR = 'files';
const CLIENT_FILES_MANIFEST_URL = () => `${SERVER_URL}/client-files/manifest.json`;
const INTEGRITY_SYNC_MAX_ROUNDS = 3;
const INTEGRITY_FILE_RETRIES = 3;

function resolveInstallFilesPath(repoPath) {
    return path.join(getInstallRoot(), INSTALL_FILES_SUBDIR, repoPath);
}

function resolveIntegrityStoragePath(repoPath) {
    if (INTEGRITY_CORE_FILES.has(repoPath)) {
        return resolveCoreWritePath(repoPath);
    }
    const besideMain = path.join(__dirname, repoPath);
    if (!app.isPackaged) return besideMain;
    if (canWritePath(besideMain)) return besideMain;
    return resolveInstallFilesPath(repoPath);
}

function resolveAppReadPath(repoPath) {
    const besideMain = path.join(__dirname, repoPath);
    if (fs.existsSync(besideMain)) return besideMain;
    const besideExe = resolveInstallFilesPath(repoPath);
    if (fs.existsSync(besideExe)) return besideExe;
    return resolveResourcePath(repoPath);
}

function clearStaleOverlayCopy(repoPath, writtenPath) {
    if (!app.isPackaged) return;
    const overlay = resolveInstallFilesPath(repoPath);
    const besideMain = path.join(__dirname, repoPath);
    if (writtenPath === besideMain && fs.existsSync(overlay)) {
        try { fs.unlinkSync(overlay); } catch { /* ignore */ }
    }
}

function isTrackedPath(repoPath) {
    return INTEGRITY_TRACKED_PATHS.some((prefix) =>
        (typeof prefix === 'string' && prefix.endsWith('/'))
            ? repoPath.startsWith(prefix)
            : repoPath === prefix,
    );
}

function isVersionOlder(localVer, remoteVer) {
    const pa = String(localVer || '0').split('.').map((n) => Number(n) || 0);
    const pb = String(remoteVer || '0').split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const a = pa[i] || 0;
        const b = pb[i] || 0;
        if (a < b) return true;
        if (a > b) return false;
    }
    return false;
}

function resolveIntegrityLocalPath(repoPath) {
    const storage = resolveIntegrityStoragePath(repoPath);
    if (fs.existsSync(storage)) return storage;
    return resolveAppReadPath(repoPath);
}

// ==================== ПРЕДЗАГРУЗКА БАЗЫ ЗАКОНОДАТЕЛЬСТВА С GITHUB ====================
// Раньше законодательство кэшировалось на диск в папку local_laws/ (см. старый обработчик
// 'fetch-law-file'). Эта логика полностью убрана: теперь актуальная база кодексов целиком
// подгружается с GitHub в оперативную память ГЛАВНОГО процесса строго во время показа
// splash.html, и к моменту открытия основного окна (legit.html) данные уже лежат в памяти —
// переход происходит мгновенно, без сетевого запроса и без обращения к диску.
const LAWS_GITHUB_OWNER = 'afekns';
const LAWS_GITHUB_REPO = 'LegitRMRPHelper';
const LAWS_GITHUB_BRANCH = 'main';
const LAWS_MANIFEST = [
    { id: 'uk', file: 'uk.json' },
    { id: 'pk', file: 'pk.json' },
    { id: 'ypk', file: 'ypk.json' },
    { id: 'gun', file: 'gun.json' },
    { id: 'gov', file: 'gov.json' },
    { id: 'police', file: 'police.json' },
    { id: 'koap', file: 'koap.json' },
    { id: 'pdd', file: 'pdd.json' },
    { id: 'prosecutor', file: 'prosecutor.json' },
    { id: 'sk', file: 'sk.json' },
    { id: 'zone', file: 'zone.json' }
];

// Хранится ТОЛЬКО в памяти процесса — ни один кодекс больше не пишется на диск.
let lawsCache = {};

async function fetchLawJsonBuffer(entry) {
    const sources = [
        { label: 'сервер RMRP', url: `${SERVER_URL}/laws/${entry.file}` },
        { label: 'GitHub', url: `https://raw.githubusercontent.com/${LAWS_GITHUB_OWNER}/${LAWS_GITHUB_REPO}/${LAWS_GITHUB_BRANCH}/${entry.file}` },
    ];
    let lastErr;
    for (const src of sources) {
        try {
            const buffer = await httpGetBufferAny(src.url);
            JSON.parse(buffer.toString('utf8'));
            return { buffer, source: src.label };
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('Кодекс недоступен');
}

async function preloadLawsFromGithub(sendProgress) {
    const total = LAWS_MANIFEST.length;
    let done = 0;
    const loadedIds = [];
    const failedIds = [];

    sendProgress({ stage: 'laws', percent: 0, label: 'Загрузка базы законодательства…' });

    await Promise.all(LAWS_MANIFEST.map(async (entry) => {
        try {
            const { buffer, source } = await fetchLawJsonBuffer(entry);
            lawsCache[entry.id] = JSON.parse(buffer.toString('utf8'));
            loadedIds.push(entry.id);
        } catch (err) {
            failedIds.push(entry.id);
            logAction('Законодательство', 'Не удалось предзагрузить кодекс', { id: entry.id, file: entry.file, error: err.message });
        } finally {
            done++;
            sendProgress({
                stage: 'laws',
                percent: Math.round((done / total) * 100),
                label: `Загрузка базы законодательства… (${done}/${total})`,
                fileName: entry.file,
                current: done,
                total
            });
        }
    }));

    logAction('Законодательство', 'Предзагрузка базы законодательства с GitHub завершена', {
        loaded: Object.keys(lawsCache).length,
        total,
        loadedIds,
        failedIds,
        allLoaded: failedIds.length === 0
    });

    return { loaded: Object.keys(lawsCache).length, total, loadedIds, failedIds };
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function clientFilesDownloadUrl(repoPath) {
    const encoded = String(repoPath).split('/').map((p) => encodeURIComponent(p)).join('/');
    return `${SERVER_URL}/client-files/${encoded}`;
}

function getIntegrityCandidatePaths(repoPath) {
    const paths = new Set();
    try { paths.add(resolveIntegrityStoragePath(repoPath)); } catch { /* ignore */ }
    paths.add(path.join(__dirname, repoPath));
    paths.add(resolveInstallFilesPath(repoPath));
    try { paths.add(path.join(app.getAppPath(), repoPath)); } catch { /* app not ready */ }
    try { paths.add(resolveResourcePath(repoPath)); } catch { /* ignore */ }
    return [...paths].filter(Boolean);
}

function localFileMatchesSha256(repoPath, expectedSha) {
    for (const candidate of getIntegrityCandidatePaths(repoPath)) {
        const hash = sha256File(candidate);
        if (hash && hash === expectedSha) return true;
    }
    return false;
}

async function httpGetBufferRetry(url, attempts = 2) {
    let lastErr;
    for (let i = 1; i <= attempts; i += 1) {
        try {
            return await httpGetBufferAny(url);
        } catch (err) {
            lastErr = err;
            if (i < attempts) await wait(400 * i);
        }
    }
    throw lastErr || new Error('Не удалось скачать с сервера');
}

function parseClientFilesManifest(buf) {
    const manifest = JSON.parse(buf.toString('utf8'));
    const files = manifest?.files;
    if (!files || typeof files !== 'object' || !Object.keys(files).length) return null;
    return {
        files,
        source: 'vps',
        version: manifest.version || null,
        hashAlgo: manifest.hashAlgo || 'sha256',
    };
}

function getIntegrityCache() {
    try { return store.get(INTEGRITY_CACHE_KEY) || null; } catch { return null; }
}

function setIntegrityCache(catalog, coreOk) {
    if (!catalog?.version) return;
    try {
        store.set(INTEGRITY_CACHE_KEY, {
            version: catalog.version,
            source: catalog.source,
            checkedAt: Date.now(),
            coreOk: !!coreOk,
        });
    } catch { /* ignore */ }
}

function trackedFilesMatchCatalog(catalog) {
    if (!catalog?.files) return false;
    for (const [repoPath, sha] of Object.entries(catalog.files)) {
        if (!isTrackedPath(repoPath)) continue;
        if (!localFileMatchesSha256(repoPath, sha)) return false;
    }
    return true;
}

function canSkipIntegritySplash(catalog) {
    const cache = getIntegrityCache();
    if (!cache || !catalog?.version || cache.version !== catalog.version || !cache.coreOk) {
        return false;
    }
    return trackedFilesMatchCatalog(catalog);
}

/** Эталон файлов — только manifest с VPS (client-files). */
async function fetchIntegrityCatalog() {
    const buf = await httpGetBufferRetry(CLIENT_FILES_MANIFEST_URL(), 2);
    return parseClientFilesManifest(buf);
}

async function downloadIntegrityFile(entry) {
    const buffer = await httpGetBufferRetry(clientFilesDownloadUrl(entry.path), INTEGRITY_FILE_RETRIES);
    if (sha256Buffer(buffer) !== entry.sha) {
        throw new Error('Хеш скачанного файла не совпал с эталоном VPS');
    }
    const localPath = resolveIntegrityStoragePath(entry.path);
    if (!canWritePath(localPath)) {
        throw new Error(`Нет прав на запись: ${localPath}`);
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buffer);
    clearStaleOverlayCopy(entry.path, localPath);
    if (INTEGRITY_CORE_FILES.has(entry.path)) {
        const runningPath = path.join(__dirname, entry.path);
        if (runningPath !== localPath && canWritePath(runningPath)) {
            fs.writeFileSync(runningPath, buffer);
        }
    }
    return INTEGRITY_CORE_FILES.has(entry.path);
}

function collectMismatchedFiles(catalog) {
    const mismatched = [];
    for (const [repoPath, sha] of Object.entries(catalog.files)) {
        if (!isTrackedPath(repoPath)) continue;
        if (!localFileMatchesSha256(repoPath, sha)) {
            mismatched.push({ path: repoPath, sha });
        }
    }
    mismatched.sort((a, b) => {
        const aCore = INTEGRITY_CORE_FILES.has(a.path) ? 0 : 1;
        const bCore = INTEGRITY_CORE_FILES.has(b.path) ? 0 : 1;
        return aCore - bCore || a.path.localeCompare(b.path);
    });
    return mismatched;
}

async function runIntegrityCheck(sendProgress, options = {}) {
    try {
        if (!options.skipAppdata) {
            sendProgress({ stage: 'appdata', percent: 6, label: 'Проверка папки установки…' });
            fs.accessSync(getInstallRoot(), fs.constants.W_OK);
            fs.accessSync(getLocalDataDir(), fs.constants.W_OK);
            await wait(150);
        }

        sendProgress({ stage: 'integrity', percent: 18, label: 'Сверка файлов с сервером…' });

        let catalog = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            sendProgress({
                stage: 'integrity',
                percent: 18 + attempt * 4,
                label: attempt === 1 ? 'Эталон с VPS…' : 'Повтор запроса к VPS…',
            });
            try {
                catalog = await fetchIntegrityCatalog();
                if (catalog) break;
            } catch (err) {
                logAction('Целостность', 'Не удалось получить manifest с VPS', { attempt, error: err.message });
            }
            await wait(500 * attempt);
        }

        if (!catalog) {
            logAction('Целостность', 'Manifest VPS недоступен — обновление невозможно');
            sendProgress({ stage: 'integrity', percent: 100, label: 'Эталон VPS недоступен' });
            await wait(150);
            return { updatedCore: false, integrityFailed: true, reason: 'manifest_unavailable' };
        }

        if (canSkipIntegritySplash(catalog)) {
            sendProgress({ stage: 'integrity', percent: 100, label: 'Файлы актуальны' });
            logAction('Целостность', 'Быстрый путь — совпадение с VPS', { version: catalog.version });
            await wait(120);
            return { updatedCore: false, integritySkipped: true, fastPath: true };
        }

        const entries = Object.entries(catalog.files).filter(([repoPath]) => isTrackedPath(repoPath));
        const total = entries.length || 1;
        let checked = 0;

        for (const [repoPath] of entries) {
            checked += 1;
            sendProgress({
                stage: 'integrity',
                percent: 18 + Math.round((checked / total) * 24),
                label: `Сверка с VPS… (${checked}/${total})`,
                fileName: repoPath,
            });
        }

        let filesToDownload = collectMismatchedFiles(catalog);

        if (!filesToDownload.length) {
            setIntegrityCache(catalog, true);
            sendProgress({ stage: 'integrity', percent: 100, label: 'Файлы совпадают с VPS' });
            logAction('Целостность', 'Все файлы совпадают с VPS', { version: catalog.version });
            await wait(120);
            return { updatedCore: false };
        }

        logAction('Целостность', `Расхождения ${filesToDownload.length} — обновление с VPS`, {
            files: filesToDownload.map((f) => f.path),
            version: catalog.version,
        });

        let updatedCore = false;
        let downloadFailed = 0;

        for (let round = 1; round <= INTEGRITY_SYNC_MAX_ROUNDS && filesToDownload.length; round += 1) {
            if (round > 1) {
                logAction('Целостность', `Повторное обновление (${round}/${INTEGRITY_SYNC_MAX_ROUNDS})`, {
                    pending: filesToDownload.map((f) => f.path),
                });
                sendProgress({
                    stage: 'integrity',
                    percent: 40,
                    label: `Повтор обновления… (${round}/${INTEGRITY_SYNC_MAX_ROUNDS})`,
                });
                await wait(800);
            }

            const totalDl = filesToDownload.length;
            const failed = [];

            for (let i = 0; i < totalDl; i += 1) {
                const entry = filesToDownload[i];
                sendProgress({
                    stage: 'download',
                    percent: 44 + Math.round((i / totalDl) * 52),
                    label: round > 1
                        ? `Обновление (${round}/${INTEGRITY_SYNC_MAX_ROUNDS})… (${i + 1}/${totalDl})`
                        : `Загрузка с VPS… (${i + 1}/${totalDl})`,
                    fileName: entry.path,
                    current: i + 1,
                    total: totalDl,
                });
                try {
                    const coreUpdated = await downloadIntegrityFile(entry);
                    if (coreUpdated) updatedCore = true;
                } catch (err) {
                    failed.push(entry);
                    logAction('Целостность', 'Не удалось обновить файл с VPS', { file: entry.path, error: err.message, round });
                }
            }

            filesToDownload = collectMismatchedFiles(catalog);
            if (!filesToDownload.length) break;
            if (round < INTEGRITY_SYNC_MAX_ROUNDS) {
                filesToDownload = failed.length ? failed : filesToDownload;
            }
        }

        downloadFailed = filesToDownload.length;
        const passed = trackedFilesMatchCatalog(catalog);

        if (passed) {
            setIntegrityCache(catalog, true);
            sendProgress({ stage: 'integrity', percent: 100, label: 'Файлы обновлены с VPS' });
            logAction('Целостность', 'Обновление с VPS успешно', { updatedCore, version: catalog.version });
            await wait(150);
            return { updatedCore, integrityFailed: false, downloadFailed: 0 };
        }

        sendProgress({ stage: 'integrity', percent: 100, label: 'Не удалось обновить файлы' });
        logAction('Целостность', 'Проверка не пройдена — остались расхождения с VPS', {
            updatedCore,
            failed: downloadFailed,
            files: filesToDownload.map((f) => f.path),
            version: catalog.version,
        });
        await wait(150);
        return {
            updatedCore,
            integrityFailed: true,
            downloadFailed,
            reason: 'sync_incomplete',
            failedFiles: filesToDownload.map((f) => f.path),
        };
    } catch (err) {
        logAction('Целостность', 'Ошибка проверки', { error: err.message });
        sendProgress({ stage: 'integrity', percent: 100, label: 'Ошибка проверки файлов' });
        await wait(120);
        return { updatedCore: false, integrityFailed: true, reason: err.message };
    }
}

// ==================== ОРКЕСТРАЦИЯ СТАРТОВОГО ЭКРАНА ====================
// Единая последовательность, которая крутится, пока показан splash.html:
//   1) проверка интернет-соединения (блокирующая — без сети идти дальше нет смысла);
//   2) проверка целостности файлов И предзагрузка базы законодательства с GitHub — ПАРАЛЛЕЛЬНО,
//      каждая ведёт свой процент прогресса, а на боссбар выводится их усреднённое значение.
// Возвращает { networkError, updatedCore }.
/** Writable path for core files (main.js / preload.js). Packaged asar is read-only. */
function resolveCoreWritePath(fileName) {
    if (app.isPackaged) {
        const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', fileName);
        return unpacked;
    }
    return path.join(__dirname, fileName);
}

function canWritePath(filePath) {
    try {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        if (fs.existsSync(filePath)) fs.accessSync(filePath, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function sha256File(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function httpGetBufferAny(url, timeoutMs = INTEGRITY_HTTP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        try {
            const lib = url.startsWith('https:') ? https : http;
            const req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    httpGetBufferAny(res.headers.location, timeoutMs).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Подтянуть main.js/preload.js с VPS (client-core), чтобы друзья без переустановки
 * получали IPC (плавающий размер, moveWindowBy). Пишет только если каталог writable.
 * @returns {Promise<boolean>} true → нужен relaunch
 */
async function maybeUpdateClientCoreFromServer(sendProgress) {
    // Открытое ядро (npm start / electron .) — не перетираем локальные main/preload с VPS
    if (!app.isPackaged) return false;
    const files = ['main.js', 'preload.js', 'binder-runtime.js', 'binder-send.ps1'];
    try {
        if (sendProgress) {
            sendProgress({ stage: 'core', percent: 6, label: 'Проверка обновления клиента…' });
        }
        const manifestBuf = await httpGetBufferAny(`${SERVER_URL}/client-core/manifest.json`);
        const manifest = JSON.parse(manifestBuf.toString('utf8'));
        if (!manifest || !manifest.files) return false;

        const hasAnyCoreHash = files.some((name) => !!manifest.files[name]);
        if (!hasAnyCoreHash) {
            logAction('Обновление', 'client-core/manifest.json на сервере пуст — OTA ядра недоступен', {
                version: manifest.version || null,
            });
            return false;
        }

        const writeTargets = [];
        for (const name of files) {
            const expected = manifest.files[name];
            if (!expected) continue;
            const runningPath = path.join(__dirname, name);
            const runningHash = sha256File(runningPath);
            const writePath = resolveCoreWritePath(name);
            const writeHash = sha256File(writePath);
            if (runningHash === expected || writeHash === expected) continue;
            writeTargets.push({ name, path: writePath, expected });
        }
        if (!writeTargets.length) return false;

        logAction('Обновление', 'Расхождение client-core с сервером — загрузка отличающихся файлов', {
            localVersion: app.getVersion(),
            remoteVersion: String(manifest.version || '0.0.0'),
            files: writeTargets.map((t) => t.name),
        });

        if (!writeTargets.every((t) => canWritePath(t.path))) {
            logAction('Обновление', 'Каталог приложения недоступен для записи — нужна переустановка Setup/Portable', {
                packaged: app.isPackaged,
            });
            return false;
        }

        for (const t of writeTargets) {
            if (sendProgress) {
                sendProgress({ stage: 'core', percent: 8, label: `Обновление ${t.name}…` });
            }
            const buf = await httpGetBufferAny(`${SERVER_URL}/client-core/${t.name}`);
            const got = crypto.createHash('sha256').update(buf).digest('hex');
            if (t.expected && got !== t.expected) {
                throw new Error(`Хеш ${t.name} не совпал`);
            }
            fs.writeFileSync(t.path, buf);
            const runningPath = path.join(__dirname, t.name);
            if (runningPath !== t.path && canWritePath(runningPath)) {
                fs.writeFileSync(runningPath, buf);
            }
            logAction('Обновление', `Обновлён core-файл ${t.name}`, { bytes: buf.length });
        }
        return true;
    } catch (err) {
        logAction('Обновление', 'Не удалось проверить/скачать client-core', { error: err.message });
        return false;
    }
}

async function runStartupSequence(sendProgress) {
    sendProgress({ stage: 'network', percent: 2, label: 'Проверка подключения к интернету…' });
    const online = await checkInternetConnectivity();
    if (!online) {
        logAction('Система', 'Нет подключения к интернету — запуск прерван');
        return { networkError: true, failReason: 'internet', updatedCore: false };
    }

    sendProgress({ stage: 'server', percent: 5, label: 'Проверка сервера RMRP Helper…' });
    const serverOk = await checkServerConnectivity(10000, 2);
    if (!serverOk) {
        logAction('Система', 'Сервер RMRP Helper недоступен — запуск прерван', { serverUrl: SERVER_URL });
        return { networkError: true, failReason: 'server', updatedCore: false };
    }

    const integrityResult = await runIntegrityCheck(sendProgress, { skipAppdata: true });
    if (integrityResult.updatedCore) {
        return { networkError: false, updatedCore: true };
    }
    if (integrityResult.integrityFailed || integrityResult.downloadFailed > 0) {
        return {
            networkError: true,
            failReason: 'integrity',
            updatedCore: false,
            reason: integrityResult.reason || 'sync_incomplete',
        };
    }

    let appdataPercent = 0;
    let lawsPercent = 0;
    let latestStage = 'appdata';
    let latestLabel = 'Проверка данных приложения…';
    let latestFile;

    function emitCombined() {
        const combined = Math.round(5 + ((appdataPercent + lawsPercent) / 200) * 95);
        sendProgress({ stage: latestStage, percent: Math.min(99, combined), label: latestLabel, fileName: latestFile });
    }

    const appdataPromise = (async () => {
        try {
            sendProgress({ stage: 'appdata', percent: 0, label: 'Проверка папки установки…' });
            const installRoot = getInstallRoot();
            fs.accessSync(installRoot, fs.constants.W_OK);
            fs.accessSync(getLocalDataDir(), fs.constants.W_OK);
            appdataPercent = 100;
            emitCombined();
            return { ok: true };
        } catch (err) {
            logAction('Система', 'Папка установки недоступна для записи', { error: err.message, installRoot: getInstallRoot() });
            return { ok: false, error: err.message };
        }
    })();

    void preloadLawsFromGithub((data) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('startup-progress', {
                stage: 'laws-bg',
                percent: Math.min(99, Math.round(5 + ((data.percent || 0) / 100) * 30)),
                label: data.label || 'Законодательство в фоне…',
                fileName: data.fileName,
            });
        }
    }).catch(() => {});

    const appdataResult = await appdataPromise;

    if (!appdataResult?.ok) {
        return {
            networkError: true,
            failReason: 'appdata',
            updatedCore: false,
        };
    }

    sendProgress({ stage: 'done', percent: 100, label: 'Готово' });
    await wait(250);

    return { networkError: false, updatedCore: false };
}

// ==================== ЛОГИРОВАНИЕ ДЕЙСТВИЙ ПОЛЬЗОВАТЕЛЯ ====================
// Локальный журнал рядом с программой (не %APPDATA%). Это НЕ телеметрия.
const LOG_MAX_LINES = 5000;
let logWriteCount = 0;
let logFilePath = null;
let logInitDone = false;

function getLogFilePath() {
    if (!logFilePath) {
        logFilePath = path.join(getInstallRoot(), 'logs.txt');
    }
    return logFilePath;
}

function initLogFile() {
    if (logInitDone) return;
    logInitDone = true;
    try {
        const dir = getInstallRoot();
        fs.mkdirSync(dir, { recursive: true });
        const target = getLogFilePath();
        const legacyBesideMain = path.join(__dirname, 'logs.txt');
        if (!fs.existsSync(target)) {
            if (fs.existsSync(legacyBesideMain)) {
                fs.copyFileSync(legacyBesideMain, target);
            } else {
                fs.writeFileSync(target, '', 'utf8');
            }
        }
    } catch (err) {
        console.error('⚠️ Не удалось инициализировать logs.txt:', err.message);
    }
}

function logAction(category, message, meta = null) {
    initLogFile();
    const timestamp = new Date().toLocaleString('ru-RU');
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] [${category}] ${message}${metaStr}\n`;
    fs.promises.appendFile(getLogFilePath(), line, 'utf8').catch((err) => {
        console.error('⚠️ Не удалось записать в logs.txt:', err.message);
    });
    logWriteCount++;
    if (logWriteCount % 200 === 0) {
        setImmediate(trimLogFile);
    }
}

function trimLogFile() {
    try {
        const logPath = getLogFilePath();
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        if (lines.length > LOG_MAX_LINES) {
            fs.writeFileSync(logPath, lines.slice(lines.length - LOG_MAX_LINES).join('\n'), 'utf8');
        }
    } catch {
        // Файла ещё может не существовать при самом первом запуске — не критично
    }
}

ipcMain.handle('get-log-file-path', () => getLogFilePath());
ipcMain.handle('get-app-version', () => app.getVersion());

// ==================== TELEGRAM-АВТОРИЗАЦИЯ (JWT, ТЗ п.2.1 / п.3.2) ====================
function saveRefreshToken(token) {
    if (!token) return;
    if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(token);
        store.set(AUTH_REFRESH_KEY, encrypted.toString('base64'));
    } else {
        store.set(AUTH_REFRESH_KEY, token);
    }
}

function loadRefreshToken() {
    const stored = store.get(AUTH_REFRESH_KEY);
    if (!stored) return null;
    if (!safeStorage.isEncryptionAvailable()) return stored;
    try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (err) {
        console.error('⚠️ Не удалось расшифровать refresh-токен:', err.message);
        return null;
    }
}

function clearAuthSession() {
    accessToken = null;
    store.delete(AUTH_REFRESH_KEY);
}

/**
 * Сброс локальных данных пользователя при выходе или смене Telegram-аккаунта.
 * Критично для приватности (ТЗ №4 п.1): без сброса Settings показывал чужой профиль.
 */
function resetLocalUserSession({ keepTelemetryConsent = false } = {}) {
    const previous = store.get('rmrpUserData') || {};
    for (const key of LOCAL_SYNC_KEYS) {
        store.delete(key);
    }
    store.delete(SYNC_META_KEY);
    store.delete('rmrp_ghost_mode');
    tagInfoCache = { data: null, at: 0 };

    const next = {
        registered: false,
        updatedAt: new Date().toISOString(),
    };
    if (keepTelemetryConsent && previous.telemetryConsent === true) {
        next.telemetryConsent = true;
    }
    store.set('rmrpUserData', next);
}

function getUserIdFromAccessToken() {
    if (!accessToken) return null;
    try {
        const part = accessToken.split('.')[1];
        if (!part) return null;
        const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const payload = JSON.parse(json);
        return payload.sub || null;
    } catch {
        return null;
    }
}

const MAINT_POLL_MS = 8000;
const MAINT_GATE_CACHE_MS = 90000;
let maintenanceWatchTimer = null;
let maintenanceGateCache = { data: null, at: 0 };

async function fetchMaintenanceGate() {
    try {
        await ensureAuthSession();
        const headers = { Accept: 'application/json' };
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(`${SERVER_URL}/auth/maintenance/status`, {
            headers,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.isActive) return null;
        if (data?.bypass) return null;
        const localRole = store.get('rmrpUserData')?.role;
        if (isClientMaintenanceBypassRole(localRole)) return null;
        return data;
    } catch {
        /* ignore */
    }
    return null;
}

async function fetchMaintenanceGateCached(force = false) {
    const now = Date.now();
    if (!force && now - maintenanceGateCache.at < MAINT_GATE_CACHE_MS) {
        return maintenanceGateCache.data;
    }
    const data = await fetchMaintenanceGate();
    maintenanceGateCache = { data, at: now };
    return data;
}

function invalidateMaintenanceGateCache() {
    maintenanceGateCache = { data: null, at: 0 };
}

function stopMaintenanceWatch() {
    if (maintenanceWatchTimer) {
        clearInterval(maintenanceWatchTimer);
        maintenanceWatchTimer = null;
    }
}

async function tickMaintenanceWatch() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const url = mainWindow.webContents.getURL();
        if (!url || !url.includes('/maintenance')) {
            stopMaintenanceWatch();
            return;
        }
        const maint = await fetchMaintenanceGateCached();
        if (!maint) {
            stopMaintenanceWatch();
            loadAppPage(mainWindow, 'main');
        }
    } catch {
        /* ignore */
    }
}

function startMaintenanceWatch() {
    stopMaintenanceWatch();
    tickMaintenanceWatch();
    maintenanceWatchTimer = setInterval(tickMaintenanceWatch, MAINT_POLL_MS);
}

function bumpMaintenanceWatchSoon() {
    if (!maintenanceWatchTimer) return;
    setTimeout(() => tickMaintenanceWatch(), 400);
}

function redirectToMaintenancePage(win = mainWindow) {
    if (!win || win.isDestroyed()) return;
    loadAppPage(win, 'maintenance');
    if (win === mainWindow) startMaintenanceWatch();
}

async function authApiFetch(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
    }
    const timeoutMs = Number(options.timeoutMs) || 20000;
    const maxAttempts = Number(options.retries) || 3;
    const { timeoutMs: _omitT, retries: _omitR, ...fetchOptions } = options;
    let lastErr = null;
    let response = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            response = await fetch(`${SERVER_URL}${path}`, {
                ...fetchOptions,
                headers,
                signal: controller.signal,
            });
            clearTimeout(timer);
            let peek = null;
            try {
                peek = await response.clone().json();
            } catch {
                peek = null;
            }
            if (response.status === 503 && peek?.maintenance) {
                await refreshAccessTokenFromStorage();
                const gate = await fetchMaintenanceGate();
                if (!gate && attempt < maxAttempts) {
                    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
                    continue;
                }
                if (gate) {
                    redirectToMaintenancePage();
                    return {
                        maintenance: true,
                        message: peek.message,
                        eta: peek.eta,
                        error: 'maintenance',
                    };
                }
                if (attempt < maxAttempts) continue;
            }
            if (response.status === 401 && attempt < maxAttempts) {
                const refreshed = await refreshAccessTokenFromStorage();
                if (refreshed && accessToken) {
                    headers.Authorization = `Bearer ${accessToken}`;
                    continue;
                }
            }
            if (response.status >= 500 && attempt < maxAttempts) {
                await wait(600 * attempt);
                continue;
            }
            break;
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;
            if (attempt < maxAttempts) {
                await wait(600 * attempt);
                continue;
            }
            throw lastErr;
        }
    }
    if (!response) {
        throw lastErr || new Error('Сервер недоступен');
    }
    let data;
    try {
        data = await response.json();
    } catch {
        data = { error: 'Некорректный ответ сервера' };
    }
    if (!response.ok) {
        if (!data.error) {
            data.error = data.message || `Ошибка сервера (${response.status})`;
        }
    }
    return data;
}

function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Сохраняет профиль с сервера. Поля identity никогда не «дотягиваются» из предыдущего
 * аккаунта: пустой nickname на сервере → пустой локально (а не ник чужого пользователя).
 */
function persistAuthUser(user) {
    if (!user) return;
    const previous = store.get('rmrpUserData') || {};
    const nextUserId = user.id != null ? String(user.id) : '';
    const nextTelegramId = user.telegram_id != null ? String(user.telegram_id) : '';
    const prevUserId = previous.userId != null ? String(previous.userId) : '';
    const prevTelegramId = previous.telegramId != null ? String(previous.telegramId) : '';

    // Сброс локальных данных только при смене user id (другой аккаунт).
    // Смена telegram_id у того же пользователя (админка) не должна «выбивать» профиль.
    const accountChanged = !!(nextUserId && prevUserId && nextUserId !== prevUserId);

    if (accountChanged) {
        resetLocalUserSession({ keepTelemetryConsent: false });
    }

    const base = store.get('rmrpUserData') || {};

    // Если сервер прислал поле (в т.ч. null) — берём его; иначе при смене аккаунта пусто,
    // при том же аккаунте можно оставить локальное (например telemetryConsent).
    const pickServerString = (serverKey, localKey) => {
        if (hasOwn(user, serverKey)) {
            const v = user[serverKey];
            return v == null || v === '' ? '' : String(v);
        }
        if (accountChanged) return '';
        return base[localKey] || '';
    };

    const merged = {
        ...base,
        userId: nextUserId || base.userId || '',
        telegramId: nextTelegramId || (accountChanged ? '' : (base.telegramId || '')),
        nickname: pickServerString('nickname', 'nickname'),
        staticId: pickServerString('static_id', 'staticId'),
        userTag: pickServerString('user_tag', 'userTag'),
        tagChangedAt: hasOwn(user, 'tag_changed_at')
            ? (user.tag_changed_at || null)
            : (accountChanged ? null : (base.tagChangedAt || null)),
        role: hasOwn(user, 'role')
            ? (user.role || 'user')
            : (accountChanged ? 'user' : (base.role || 'user')),
        updatedAt: new Date().toISOString(),
    };

    merged.registered = isProfileComplete(merged);
    if (merged.registered && !merged.registeredAt) {
        merged.registeredAt = base.registeredAt || new Date().toISOString();
    }
    if (!merged.registered) {
        // Неполный профиль — не считаем «зарегистрированным» и не тащим старый registeredAt
        if (accountChanged || !base.registered) {
            delete merged.registeredAt;
        }
    }

    store.set('rmrpUserData', merged);
}

function isProfileComplete(userData) {
    if (!userData) return false;
    // Секретное слово на клиент с /users/me не отдаётся — полнота = ник + статик + тег
    // (сервер дополнительно требует secret_word при completeOnboarding).
    return !!(
        String(userData.nickname || '').trim()
        && String(userData.staticId || '').trim()
        && String(userData.userTag || '').trim()
    );
}

function isServerIdentityComplete(profile) {
    if (!profile) return false;
    return !!(
        String(profile.nickname || '').trim()
        && String(profile.static_id || profile.staticId || '').trim()
        && String(profile.user_tag || profile.userTag || '').trim()
    );
}

function decodeAccessTokenPayload() {
    if (!accessToken) return null;
    try {
        const part = accessToken.split('.')[1];
        if (!part) return null;
        const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function isAccessTokenExpired(bufferSec = 45) {
    const payload = decodeAccessTokenPayload();
    if (!payload?.exp) return false;
    return Date.now() >= (Number(payload.exp) - bufferSec) * 1000;
}

function isClientMaintenanceBypassRole(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'tester') return true;
    return r === 'test' || r === 'admin' || r === 'tehnical' || r === 'technical';
}

async function refreshAccessTokenFromStorage() {
    const refreshToken = loadRefreshToken();
    if (!refreshToken) return false;

    try {
        // Прямой fetch — не через authApiFetch (иначе 503 техработ блокирует refresh у staff)
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(`${SERVER_URL}/auth/telegram/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ refreshToken }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const result = await res.json().catch(() => ({}));
        if (!res.ok || result.error || !result.accessToken) {
            const hardInvalid = res.status === 401
                || result.error === 'invalid_refresh_token'
                || result.error === 'invalid_refresh';
            if (hardInvalid) clearAuthSession();
            return false;
        }
        accessToken = result.accessToken;
        if (result.refreshToken) {
            saveRefreshToken(result.refreshToken);
        }
        return true;
    } catch (err) {
        console.error('⚠️ Ошибка обновления access-токена:', err.message);
        return false;
    }
}

async function ensureAuthSession() {
    if (accessToken && !isAccessTokenExpired()) return true;
    if (accessToken && isAccessTokenExpired()) accessToken = null;
    return refreshAccessTokenFromStorage();
}

let tagInfoCache = { data: null, at: 0 };
const TAG_INFO_TTL_MS = 10 * 60 * 1000;
let lastSocialProfileCache = null;

async function resolveStartPage(skipProfileFetch = false) {
    const hasSession = await ensureAuthSession();
    if (!hasSession) {
        return 'reg';
    }

    const maint = await fetchMaintenanceGateCached();
    if (maint) return 'maintenance';
    let serverSaysIncomplete = false;
    if (!skipProfileFetch) {
        const profile = await fetchServerProfile();
        if (profile && profile.profileComplete === false
            && !(profile.identityComplete || isServerIdentityComplete(profile))) {
            serverSaysIncomplete = true;
        }
    }
    const userData = store.get('rmrpUserData') || {};
    // Сервер — источник истины: неполный профиль всегда на onboard, даже если
    // в electron-store остался «мусор» от предыдущей сессии.
    if (serverSaysIncomplete || !isProfileComplete(userData)) {
        return 'onboard';
    }
    if (userData.telemetryConsent !== true) {
        return 'locked';
    }
    return 'main';
}

// ==================== СИНХРОНИЗАЦИЯ С СЕРВЕРОМ (профиль + локальный блоб, ТЗ п.2.3) ====================
// Пока блоб — JSON (шифрование AES-256 добавится на этапе 5). Сервер хранит payload как непрозрачную строку.
const LOCAL_SYNC_KEYS = [
    'rmrp_hotkeys',
    'rmrp_binds',
    'rmrp_timers',
    'rmrp_timer_sound',
    'rmrp_rp_token',
];
const SYNC_META_KEY = 'rmrp_sync_meta';
let syncPushTimer = null;

function collectLocalSyncData() {
    const data = {};
    for (const key of LOCAL_SYNC_KEYS) {
        const value = store.get(key);
        if (value !== undefined) data[key] = value;
    }
    return data;
}

function applyLocalSyncData(data) {
    if (!data || typeof data !== 'object') return false;
    let changed = false;
    for (const key of LOCAL_SYNC_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            store.set(key, data[key]);
            changed = true;
        }
    }
    return changed;
}

function scheduleSyncPush() {
    if (syncPushTimer) clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(() => {
        syncPushTimer = null;
        pushLocalSync();
    }, 3000);
}

async function fetchServerProfile() {
    if (!(await ensureAuthSession())) return null;
    try {
        const profile = await authApiFetch('/users/me');
        if (profile && profile.id) {
            persistAuthUser(profile);
            if (profile.profileComplete === false
                && !(profile.identityComplete || isServerIdentityComplete(profile))) {
                const cur = store.get('rmrpUserData') || {};
                store.set('rmrpUserData', {
                    ...cur,
                    nickname: hasOwn(profile, 'nickname') ? (profile.nickname || '') : '',
                    staticId: hasOwn(profile, 'static_id') ? (profile.static_id || '') : '',
                    userTag: hasOwn(profile, 'user_tag') ? (profile.user_tag || '') : '',
                    registered: false,
                    updatedAt: new Date().toISOString(),
                });
            }
            return profile;
        }
    } catch (err) {
        console.error('⚠️ Не удалось загрузить профиль с сервера:', err.message);
    }
    return null;
}

async function pushServerProfile(fields) {
    if (!(await ensureAuthSession())) {
        return { success: false, error: 'Нет авторизации' };
    }
    try {
        const result = await authApiFetch('/users/me', {
            method: 'PATCH',
            body: JSON.stringify(fields),
        });
        if (result && result.success && result.user) {
            persistAuthUser(result.user);
            return { success: true, user: result.user };
        }
        return { success: false, error: (result && result.error) || 'Сервер отклонил сохранение' };
    } catch (err) {
        console.error('⚠️ Не удалось сохранить профиль на сервере:', err.message);
        return { success: false, error: err.message || 'Сервер недоступен' };
    }
}

async function pushLocalSync() {
    if (!(await ensureAuthSession())) return;
    const updatedAt = new Date().toISOString();
    try {
        await authApiFetch('/sync/push', {
            method: 'POST',
            body: JSON.stringify({
                payload: JSON.stringify(collectLocalSyncData()),
                updatedAt,
            }),
        });
        const meta = store.get(SYNC_META_KEY) || {};
        store.set(SYNC_META_KEY, { ...meta, lastPushAt: updatedAt });
    } catch (err) {
        console.error('⚠️ Не удалось отправить локальный бэкап на сервер:', err.message);
    }
}

async function pullLocalSync() {
    if (!(await ensureAuthSession())) return;
    try {
        const remote = await authApiFetch('/sync/pull');
        if (!remote || !remote.payload) return;

        const meta = store.get(SYNC_META_KEY) || {};
        const remoteAt = remote.updated_at ? new Date(remote.updated_at).getTime() : 0;
        const localAt = meta.lastPushAt ? new Date(meta.lastPushAt).getTime() : 0;

        if (remoteAt <= localAt) return;

        const data = JSON.parse(remote.payload);
        if (applyLocalSyncData(data)) {
            scheduleRegisterAllGlobalShortcuts();
            rescheduleStoredTimers();
            logAction('Синхронизация', 'Локальные настройки восстановлены с сервера');
        }
        store.set(SYNC_META_KEY, { ...meta, lastPullAt: remote.updated_at });
    } catch (err) {
        console.error('⚠️ Не удалось загрузить локальный бэкап с сервера:', err.message);
    }
}

async function hydrateSessionFromServer() {
    if (!(await ensureAuthSession())) return;
    // Сначала профиль: только после полной регистрации тянем локальный sync-blob.
    // Иначе новый Telegram-аккаунт мог «унаследовать» хоткеи/настройки предыдущего пользователя
    // из-за сравнения lastPushAt (ТЗ №4 п.1).
    await fetchServerProfile();
    const userData = store.get('rmrpUserData') || {};
    if (isProfileComplete(userData)) {
        await pullLocalSync();
    }
}

// ==================== ТЕЛЕМЕТРИЯ И СОГЛАСИЕ НА ОБРАБОТКУ ДАННЫХ ====================
// ВАЖНО: собираются ТОЛЬКО обезличенные технические метрики (частота посещения вкладок,
// разрешение экрана, крэш-логи, количество запусков, серия дней и онлайн за день).
// Никнейм, статический ID, IP-адрес и т.п. НИКОГДА не входят в отправляемый payload.
// URL телеметрии задаётся только через .env (TELEMETRY_ENDPOINT_URL) при сборке — не храним в git.
const TELEMETRY_ENDPOINT_URL = String(process.env.TELEMETRY_ENDPOINT_URL || '').trim();

function isTelemetryBackendConfigured() {
    return TELEMETRY_ENDPOINT_URL.startsWith('https://');
}

// ==================== ВОССТАНОВЛЕНИЕ ДОСТУПА ПО КОДУ ====================
// Пользователь получает одноразовый код восстановления по ссылке/у @rmrphelper_bot (бот сверяет
// секретное слово/InstallID и выдаёт код). Здесь мы этот код просто проверяем в базе — так же,
// как и с телеметрией, никакого секретного ключа в клиенте нет: стучимся в отдельную Edge Function,
// задеплоенную с --no-verify-jwt, а она уже сама обращается к базе с service_role ключом.
//
// URL восстановления — только из .env (RESTORE_ENDPOINT_URL), не публикуем в репозитории.
const RESTORE_ENDPOINT_URL = String(process.env.RESTORE_ENDPOINT_URL || '').trim();

function isRestoreBackendConfigured() {
    return RESTORE_ENDPOINT_URL.startsWith('https://');
}

// Делает POST-запрос к Edge Function восстановления и возвращает распарсенный JSON-ответ.
// Ожидаемый формат ответа от бэкенда:
//   { success: true, data: { nickname, staticId, secretWord, onlineHistory, streakData } }
//   { success: false, error: "Неверный код восстановления" }
function requestAccountRestore(installId, code) {
    return new Promise((resolve) => {
        if (!isRestoreBackendConfigured()) {
            resolve({ success: false, error: 'Сервис восстановления временно недоступен. Попробуйте позже.' });
            return;
        }

        let endpoint;
        try {
            endpoint = new URL(RESTORE_ENDPOINT_URL);
        } catch (err) {
            resolve({ success: false, error: 'Некорректный адрес сервиса восстановления.' });
            return;
        }

        const requestBody = JSON.stringify({
            install_id: installId,
            code: String(code || '').trim()
        });

        const req = https.request({
            hostname: endpoint.hostname,
            path: endpoint.pathname + endpoint.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            },
            timeout: 8000
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    resolve({ success: false, error: `Сервер ответил ошибкой (${res.statusCode})` });
                    return;
                }
                try {
                    const parsed = JSON.parse(raw);
                    resolve(parsed);
                } catch (err) {
                    resolve({ success: false, error: 'Некорректный ответ сервера' });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, error: 'Превышено время ожидания ответа сервера' });
        });
        req.on('error', (err) => {
            resolve({ success: false, error: 'Не удалось связаться с сервером: ' + err.message });
        });

        req.write(requestBody);
        req.end();
    });
}

// ==================== ПРИВЯЗКА INSTALL ID К ЖЕЛЕЗУ УСТРОЙСТВА ====================
// Раньше install_id был просто случайным crypto.randomUUID(), сохранённым в electron-store —
// то есть он менялся при любой переустановке (или просто при удалении файла стора), и в Supabase
// один и тот же человек выглядел как "новый" пользователь после каждой переустановки.
// Теперь ID детерминированно вычисляется из железа устройства (Machine GUID в реестре Windows,
// либо MAC-адрес/hostname как запасной вариант), поэтому даже после полной переустановки
// приложения он пересчитается в то же самое значение — само устройство не изменилось.
function getWindowsMachineGuid() {
    try {
        const out = require('child_process').execSync(
            'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
            { encoding: 'utf8', windowsHide: true }
        );
        const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
        return match ? match[1].trim() : null;
    } catch (err) {
        return null;
    }
}

function getMacMachineId() {
    try {
        const out = require('child_process').execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8' });
        const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        return match ? match[1] : null;
    } catch (err) {
        return null;
    }
}

function getLinuxMachineId() {
    try {
        return fs.readFileSync('/etc/machine-id', 'utf8').trim() || null;
    } catch (err) {
        try {
            return fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim() || null;
        } catch (err2) {
            return null;
        }
    }
}

// Запасной вариант, если не удалось прочитать системный machine ID (например, нет прав на реестр):
// берём MAC-адрес первого "настоящего" (не внутреннего) сетевого интерфейса — он тоже привязан
// к физическому устройству, а не к установке приложения.
function getPrimaryMacAddress() {
    try {
        const ifaces = require('os').networkInterfaces();
        for (const name of Object.keys(ifaces).sort()) {
            for (const iface of ifaces[name]) {
                if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                    return iface.mac;
                }
            }
        }
    } catch (err) {
        // игнорируем — уйдём на самый последний запасной вариант ниже
    }
    return null;
}

function getHardwareFingerprint() {
    let raw = null;
    if (process.platform === 'win32') raw = getWindowsMachineGuid();
    else if (process.platform === 'darwin') raw = getMacMachineId();
    else raw = getLinuxMachineId();

    if (!raw) raw = getPrimaryMacAddress();
    if (!raw) raw = require('os').hostname(); // самый последний запасной вариант — хотя бы стабилен на этой машине

    return raw;
}

// Форматируем sha256-хеш как обычный UUID-подобный ID — просто для читаемости в логах/базе,
// само значение при этом остаётся детерминированным (не случайным).
function computeDeviceInstallId() {
    const fingerprint = getHardwareFingerprint();
    const hash = crypto.createHash('sha256').update(`rmrp-helper-device::${fingerprint}`).digest('hex').slice(0, 32);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// Анонимный ID установки — НЕ привязан к никнейму/статическому ID, но привязан к устройству,
// поэтому переживает переустановку приложения (см. computeDeviceInstallId выше).
function getOrCreateInstallId() {
    let id = store.get('rmrp_telemetry_install_id');
    if (!id) {
        id = computeDeviceInstallId();
        store.set('rmrp_telemetry_install_id', id);
    }
    return id;
}

function getTelemetryConsent() {
    const userData = store.get('rmrpUserData');
    return !!(userData && userData.telemetryConsent === true);
}

function setTelemetryConsent(value) {
    const userData = store.get('rmrpUserData') || {};
    userData.telemetryConsent = value === true;
    store.set('rmrpUserData', userData);
    return userData.telemetryConsent;
}

// Локальная очередь на случай отсутствия сети/незаполненного маркера — чтобы события не терялись молча
function queueTelemetryLocally(eventType, payload) {
    const queue = store.get('rmrp_telemetry_queue') || [];
    queue.push({ eventType, payload, queuedAt: new Date().toISOString() });
    store.set('rmrp_telemetry_queue', queue.slice(-200)); // не даём очереди расти бесконечно
}

const TELEMETRY_FORBIDDEN_KEYS = new Set([
    'secretWord', 'secret_word', 'password', 'token', 'refreshToken', 'accessToken',
    'apiKey', 'api_key', 'authorization', 'jwt',
]);

function sanitizeTelemetryPayload(payload) {
    if (!payload || typeof payload !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
        if (TELEMETRY_FORBIDDEN_KEYS.has(key)) continue;
        if (typeof value === 'string' && value.length > 500) {
            out[key] = value.slice(0, 500);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function sendTelemetryEvent(eventType, payload = {}) {
    // Железное правило: без явного согласия ни один байт телеметрии не покидает устройство
    if (!getTelemetryConsent()) return;

    const safePayload = sanitizeTelemetryPayload(payload);
    const eventBody = JSON.stringify({
        install_id: getOrCreateInstallId(),
        event_type: eventType,
        payload: safePayload,
        app_version: app.getVersion(),
        platform: process.platform,
        created_at: new Date().toISOString()
    });

    if (!isTelemetryBackendConfigured()) {
        // URL прокси-функции ещё не вставлен разработчиком — просто копим локально, ничего не ломаем
        queueTelemetryLocally(eventType, payload);
        return;
    }

    try {
        const endpoint = new URL(TELEMETRY_ENDPOINT_URL);
        const req = https.request({
            hostname: endpoint.hostname,
            path: endpoint.pathname + endpoint.search,
            method: 'POST',
            headers: {
                // Никакого apikey/Authorization — функция задеплоена с --no-verify-jwt именно
                // для того, чтобы в клиенте не нужно было хранить вообще никакой секрет
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(eventBody)
            },
            timeout: 8000
        }, (res) => {
            if (res.statusCode >= 400) {
                console.warn(`⚠️ [Телеметрия]: сервер ответил ${res.statusCode}, событие поставлено в локальную очередь`);
                queueTelemetryLocally(eventType, payload);
            }
            res.resume();
        });
        req.on('timeout', () => req.destroy());
        req.on('error', (err) => {
            console.warn('⚠️ [Телеметрия]: сеть недоступна, событие поставлено в локальную очередь:', err.message);
            queueTelemetryLocally(eventType, payload);
        });
        req.write(eventBody);
        req.end();
    } catch (err) {
        queueTelemetryLocally(eventType, payload);
    }
}

function logCrashLocally(type, message, stack) {
    const crashes = store.get('rmrp_crash_logs') || [];
    crashes.push({
        type,
        message: String(message || '').slice(0, 500),
        stack: String(stack || '').slice(0, 2000),
        at: new Date().toISOString()
    });
    store.set('rmrp_crash_logs', crashes.slice(-50));
    logAction('Ошибка', `Крэш приложения: ${type}`, { message: String(message || '').slice(0, 300) });
    sendTelemetryEvent('crash', { type, message: String(message || '').slice(0, 300) });
}

// ==================== СЕРИЯ ДНЕЙ (STREAK) И ОНЛАЙН ЗА ДЕНЬ ====================
// Серия = сколько дней ПОДРЯД (календарь, локальное время) пользователь отыграл
// минимум STREAK_MIN_MINUTES (1 час). Источник истины — rmrp_online_history
// (минуты по часам суток из фонового трекера GTA/RAGE).
// Запуск Helper сам по себе серию НЕ продлевает.
const STREAK_MIN_MINUTES = 60;

function formatLocalDateString(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** getTodayDateString is defined later near the online tracker; forward-safe helpers use formatLocalDateString */

function getDayOnlineMinutes(dateStr, history) {
    const hist = history || store.get('rmrp_online_history') || {};
    const day = hist[dateStr];
    if (!day) return 0;
    if (Array.isArray(day)) {
        return day.reduce((sum, m) => sum + (Number(m) || 0), 0);
    }
    if (typeof day === 'number') return day;
    return 0;
}

function getTodayOnlineMinutes() {
    return getDayOnlineMinutes(formatLocalDateString(new Date()));
}

/**
 * Считает «строгую» серию по истории онлайна.
 * Сегодня: если < 1ч — день не входит в серию, но проверяем вчера и назад (удержание).
 * Прошлый день < 1ч — серия обрывается.
 */
function calculateStrictStreakFromHistory(history) {
    const hist = history || store.get('rmrp_online_history') || {};
    const todayStr = formatLocalDateString(new Date());
    let streak = 0;
    const check = new Date();
    // Защита от бесконечного цикла
    for (let i = 0; i < 400; i++) {
        const s = formatLocalDateString(check);
        const dayMins = getDayOnlineMinutes(s, hist);

        if (s === todayStr) {
            if (dayMins >= STREAK_MIN_MINUTES) {
                streak += 1;
            }
            // Сегодня без часа — не рвём, смотрим вчера (серия «держится» до полуночи)
            check.setDate(check.getDate() - 1);
            continue;
        }

        if (dayMins >= STREAK_MIN_MINUTES) {
            streak += 1;
            check.setDate(check.getDate() - 1);
        } else {
            break;
        }
    }
    return streak;
}

/**
 * Пересчитать и сохранить серию. Возвращает объект streak + флаг «сегодня только что квалифицировались».
 */
function recomputeAndStoreStreak() {
    const history = store.get('rmrp_online_history') || {};
    const todayStr = formatLocalDateString(new Date());
    const todayMins = getDayOnlineMinutes(todayStr, history);
    const currentStreak = calculateStrictStreakFromHistory(history);
    const prev = store.get('rmrp_streak_data') || {};
    const wasQualifiedToday = prev.lastQualifiedDate === todayStr;
    const justQualified = todayMins >= STREAK_MIN_MINUTES && !wasQualifiedToday;

    const data = {
        currentStreak,
        minMinutesRequired: STREAK_MIN_MINUTES,
        lastQualifiedDate: todayMins >= STREAK_MIN_MINUTES
            ? todayStr
            : (prev.lastQualifiedDate && prev.lastQualifiedDate !== todayStr ? prev.lastQualifiedDate : null),
        lastFlashDate: prev.lastFlashDate || null,
        todayMinutes: todayMins,
        updatedAt: new Date().toISOString(),
    };
    store.set('rmrp_streak_data', data);

    if (justQualified) {
        logAction('Онлайн', `Серия дней: день засчитан (≥${STREAK_MIN_MINUTES} мин)`, {
            streak: currentStreak,
            todayMinutes: todayMins,
        });
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('streak-day-qualified', {
                    streakDays: currentStreak,
                    todayMinutes: todayMins,
                });
            }
        } catch { /* ignore */ }
    }

    return { ...data, justQualified };
}

/** @deprecated name kept for call sites — now recomputes from online history */
function updateAndGetStreak() {
    return recomputeAndStoreStreak().currentStreak || 0;
}

function recordAppLaunch() {
    const stats = store.get('rmrp_telemetry_stats') || { launchCount: 0, firstLaunchAt: null };
    stats.launchCount = (stats.launchCount || 0) + 1;
    if (!stats.firstLaunchAt) stats.firstLaunchAt = new Date().toISOString();
    stats.lastLaunchAt = new Date().toISOString();
    store.set('rmrp_telemetry_stats', stats);
    logAction('Система', `Приложение запущено (запуск №${stats.launchCount})`, { logFile: getLogFilePath() });

    let resolution = null;
    try {
        const display = screen.getPrimaryDisplay();
        resolution = `${display.size.width}x${display.size.height}`;
    } catch (e) {
        // Не критично — просто не отправим разрешение экрана в этот раз
    }

    // Пересчёт серии по онлайну (не по факту запуска)
    const streakInfo = recomputeAndStoreStreak();
    const onlineMinutesToday = streakInfo.todayMinutes || getTodayOnlineMinutes();

    sendTelemetryEvent('app_launch', {
        launchCount: stats.launchCount,
        resolution,
        streakDays: streakInfo.currentStreak || 0,
        onlineMinutesToday,
    });
}

// ==================== ГОРЯЧИЕ КЛАВИШИ (НАСТРАИВАЕМЫЕ) ====================
// toggleApp — показать/скрыть главное окно.
const DEFAULT_HOTKEYS = { toggleApp: 'F3' };
const SYSTEM_HOTKEY_LABELS = {
    toggleApp: 'Показать, скрыть окно RMRP Helper',
};

function migrateLegacyHotkeys() {
    const stored = store.get('rmrp_hotkeys');
    if (!stored || typeof stored !== 'object') return;
    if (!Object.prototype.hasOwnProperty.call(stored, 'rpToken')) return;
    const next = { ...stored };
    delete next.rpToken;
    store.set('rmrp_hotkeys', next);
}

function getStoredHotkeys() {
    const stored = store.get('rmrp_hotkeys') || {};
    const merged = { ...DEFAULT_HOTKEYS, ...stored };
    delete merged.rpToken;
    return merged;
}

const DEFAULT_RP_TOKEN = { command: '/do', text: '' };
const RP_TOKEN_COMMANDS = ['/do', '/me', '/todo'];

// Хранилище живёт в main-процессе (не localStorage) по той же причине, что и биндер: хоткей
// rpToken — глобальный, регистрируется в main.js и должен срабатывать независимо от того,
// открыта ли сейчас страница "Настройки".
function getStoredRpToken() {
    const saved = store.get('rmrp_rp_token');
    return { ...DEFAULT_RP_TOKEN, ...(saved || {}) };
}

function setStoredRpToken(payload) {
    const command = RP_TOKEN_COMMANDS.includes(payload && payload.command) ? payload.command : DEFAULT_RP_TOKEN.command;
    const text = String((payload && payload.text) || '').slice(0, 300);
    const token = { command, text };
    store.set('rmrp_rp_token', token);
    return token;
}

// Перерегистрирует ВСЕ глобальные хоткеи приложения на основе того, что сейчас лежит в сторе.
// Вызывается и при старте, и сразу после успешного сохранения новой комбинации.
function registerAppHotkeys() {
    globalShortcut.unregisterAll();
    const hotkeys = getStoredHotkeys();

    try {
        globalShortcut.register(hotkeys.toggleApp, () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindow.isVisible()) {
                mainWindow.hide();
                setImmediate(() => logAction('Хоткей', `Окно скрыто по хоткею ${hotkeys.toggleApp}`));
            } else {
                mainWindow.show();
                setImmediate(() => {
                    if (!mainWindow || mainWindow.isDestroyed()) return;
                    mainWindow.focus();
                    if (activePageRoute === 'online' && activePageView && !activePageView.webContents.isDestroyed()) {
                        setTimeout(() => {
                            if (activePageView?.webContents && !activePageView.webContents.isDestroyed()) {
                                activePageView.webContents.send('sync-online-ui');
                            }
                        }, 80);
                    }
                    logAction('Хоткей', `Окно показано по хоткею ${hotkeys.toggleApp}`);
                });
            }
        });
    } catch (err) {
        console.error(`⚠️ Не удалось зарегистрировать хоткей "toggleApp" (${hotkeys.toggleApp}):`, err.message);
    }
}

// ==================== БИНДЕР (binder.html) ====================
// Пользовательские макросы: произвольный текст, который печатается в текущее активное окно
// (как правило — чат игры) по нажатию назначенной пользователем горячей клавиши.
// Хранилище — единый объект в electron-store, а не localStorage: биндам нужно регистрироваться
// глобально сразу при старте приложения, независимо от того, открыта ли страница binder.html.
function getStoredBinds() {
    return store.get('rmrp_binds') || [];
}

async function fetchBinderSocialProfile() {
    if (!(await ensureAuthSession())) return null;
    try {
        const profile = await authApiFetch('/users/me/social');
        if (profile && !profile.error) return profile;
    } catch {
        /* ignore */
    }
    return null;
}

let binderFocusRestore = null;

async function prepareGameFocusForBinder() {
    const restoreFns = [];
    const windows = [mainWindow, splashWindow, friendsWindow, widgetWindow].filter((w) => w && !w.isDestroyed());

    for (const win of windows) {
        try {
            if (win === mainWindow) {
                const wasAlwaysOnTop = win.isAlwaysOnTop();
                const wasVisible = win.isVisible();
                const wasMinimized = win.isMinimized();
                restoreFns.push(() => {
                    try {
                        if (wasMinimized && !win.isDestroyed()) win.minimize();
                        else if (wasVisible && !win.isDestroyed()) win.show();
                        if (wasAlwaysOnTop && !win.isDestroyed()) win.setAlwaysOnTop(true);
                    } catch { /* ignore */ }
                });
                if (wasAlwaysOnTop) win.setAlwaysOnTop(false);
                if (wasVisible && !wasMinimized) win.hide();
            } else if (typeof win.isFocused === 'function' && win.isFocused()) {
                win.blur();
            }
        } catch { /* ignore */ }
    }

    binderFocusRestore = () => {
        for (let i = restoreFns.length - 1; i >= 0; i -= 1) {
            try { restoreFns[i](); } catch { /* ignore */ }
        }
        binderFocusRestore = null;
    };

    await new Promise((r) => setTimeout(r, 200));
}

function restoreAppFocusAfterBinder() {
    if (typeof binderFocusRestore === 'function') {
        binderFocusRestore();
    }
}

function getBinderChatVk() {
    const raw = Number(store.get('binderChatVk'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0x54;
}

function getBinderRuntimeOptions() {
    return {
        logAction,
        getUserData: () => store.get('rmrpUserData') || {},
        getSocialProfile: fetchBinderSocialProfile,
        isHelperPlus: async () => {
            const st = await fetchHelperPlusStatus();
            return !!st.isHelperPlus;
        },
        prepareGameFocus: prepareGameFocusForBinder,
        restoreAppFocus: restoreAppFocusAfterBinder,
        getChatVk: getBinderChatVk,
    };
}

// Регистрирует глобальные хоткеи для всех включённых биндов, у которых задана комбинация клавиш.
// Вызывается вместе с registerAppHotkeys() — см. registerAllGlobalShortcuts() ниже.
function registerBindHotkeys() {
    const binds = getStoredBinds();
    binds.forEach((bind) => {
        const migrated = binderRuntime.migrateBindRecord(bind);
        const hasSteps = migrated.steps && migrated.steps.length > 0;
        if (!bind || bind.enabled === false || !bind.hotkey || !hasSteps) return;
        try {
            const ok = globalShortcut.register(bind.hotkey, () => {
                logAction('Биндер', `Бинд "${bind.name}" сработал по хоткею ${bind.hotkey}`);
                binderRuntime.executeBindSequence(migrated, getBinderRuntimeOptions()).catch((err) => {
                    console.error(`⚠️ Ошибка автонабора для бинда "${bind.name}":`, err.message);
                });
            });
            if (!ok) {
                console.error(`⚠️ Хоткей бинда "${bind.name}" (${bind.hotkey}) не зарегистрирован — комбинация занята другой программой`);
            }
        } catch (err) {
            console.error(`⚠️ Не удалось зарегистрировать хоткей бинда "${bind.name}" (${bind.hotkey}):`, err.message);
        }
    });
}

// Единая точка перерегистрации ВСЕХ глобальных хоткеев приложения — и системных (F3/Alt+1),
// и пользовательских биндов. Всегда используется вместо голого registerAppHotkeys(), иначе
// биндер потеряет свои хоткеи при любом сохранении настроек на странице "Настройки".
function registerAllGlobalShortcuts() {
    registerAppHotkeys(); // сам делает globalShortcut.unregisterAll() первой строкой
    registerBindHotkeys();
}

let shortcutRegenPending = false;

function scheduleRegisterAllGlobalShortcuts() {
    if (shortcutRegenPending) return;
    shortcutRegenPending = true;
    setImmediate(() => {
        shortcutRegenPending = false;
        registerAllGlobalShortcuts();
    });
}

// Общие webPreferences для всех окон верхнего уровня приложения.
// SECURITY: nodeIntegration OFF — страницы не имеют require()/fs; только preload → window.electron.
// webSecurity ON — не отключаем same-origin / CORS в Chromium.
function baseWebPreferences() {
    return {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // preload needs limited node for ipcRenderer
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        backgroundThrottling: true,
        preload: path.join(__dirname, 'preload.js'),
    };
}

function setPageViewBackgroundThrottling(view, throttled) {
    if (!view?.webContents || view.webContents.isDestroyed()) return;
    try {
        view.webContents.setBackgroundThrottling(!!throttled);
    } catch { /* ignore */ }
}

function applyPageViewThrottling(activeView) {
    for (const entry of pageViewCache.values()) {
        setPageViewBackgroundThrottling(entry.view, entry.view !== activeView);
    }
}

// Перехватываем window.open(url, '_blank') (например, "Контакты создателя" и кнопка доната
// в setting.html) и открываем ссылку в системном браузере вместо нового окна Electron.
function attachExternalLinkHandler(target) {
    const wc = target && target.webContents ? target.webContents : target;
    if (!wc || wc.isDestroyed?.()) return;
    wc.setWindowOpenHandler(({ url }) => {
        try {
            const u = new URL(url);
            if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'tg:') {
                shell.openExternal(url);
            }
        } catch {
            /* ignore malicious/invalid */
        }
        return { action: 'deny' };
    });
    // Block navigation to file://, javascript:, data: from remote pages
    wc.on('will-navigate', (event, url) => {
        try {
            const u = new URL(url);
            const allowed =
                u.protocol === 'https:' ||
                u.protocol === 'http:' ||
                u.protocol === 'file:'; // local splash/offline only
            if (!allowed) {
                event.preventDefault();
                return;
            }
            // Remote pages must stay on SERVER_URL host (or localhost for dev)
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                let serverHost = '';
                try {
                    serverHost = new URL(SERVER_URL).host;
                } catch { /* */ }
                if (
                    serverHost &&
                    u.host !== serverHost &&
                    u.hostname !== 'localhost' &&
                    u.hostname !== '127.0.0.1' &&
                    !u.hostname.endsWith('.sslip.io')
                ) {
                    event.preventDefault();
                    shell.openExternal(url);
                }
            }
        } catch {
            event.preventDefault();
        }
    });
}

// ==================== ЗАГРУЗКА СТРАНИЦ С СЕРВЕРА ====================
// Единая точка входа для показа любой "серверной" страницы в окне. route — это ключ
// из белого списка PagesController на сервере (например 'main', 'setting'), а не путь
// к файлу — на клиенте эти .html больше не хранятся.
// HTTP 404 от NestJS не вызывает did-fail-load — ловим через webRequest и тело ответа.
const ALLOWED_APP_ROUTES = new Set([
    'main', 'reg', 'onboard', 'locked', 'maintenance', 'setting', 'binder', 'time', 'notein', 'online',
    'legit', 'trainer', 'maps', 'sticky', 'achievements', 'profile', 'friends', 'miniapp',
]);

function normalizeAppRoute(route) {
    const raw = String(route || 'main').replace(/\.html(?=($|\?|#))/, '');
    const qIndex = raw.indexOf('?');
    const pathPart = (qIndex >= 0 ? raw.slice(0, qIndex) : raw).replace(/^\/+/, '') || 'main';
    const query = qIndex >= 0 ? raw.slice(qIndex) : '';
    return { pathPart, cleanRoute: pathPart + query };
}

function loadOfflinePage(win, reason = 'server') {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents || win;
    if (wc.isDestroyed?.()) return;
    wc.loadFile(LOCAL_PAGES.offline(), {
        search: `?reason=${encodeURIComponent(reason)}&server=${encodeURIComponent(SERVER_URL)}`,
    });
}

function buildAppPageUrl(route) {
    const { cleanRoute } = normalizeAppRoute(route);
    const localBinderBase = (process.env.RMRP_LOCAL_BINDER_URL || '').replace(/\/$/, '');
    if (localBinderBase && cleanRoute === 'binder') {
        return `${localBinderBase}/binder.html`;
    }
    return `${SERVER_URL}/${cleanRoute}`;
}

let layoutPageViewTimer = null;

function layoutActivePageViewNow() {
    if (!mainWindow || mainWindow.isDestroyed() || !activePageView) return;
    try {
        const [w, h] = mainWindow.getContentSize();
        activePageView.setBounds({ x: 0, y: 0, width: Math.max(1, w), height: Math.max(1, h) });
        activePageView.setAutoResize({ width: true, height: true });
    } catch {
        /* ignore */
    }
}

function layoutActivePageView() {
    if (layoutPageViewTimer) clearTimeout(layoutPageViewTimer);
    layoutPageViewTimer = setTimeout(() => {
        layoutPageViewTimer = null;
        layoutActivePageViewNow();
    }, 32);
}

function dispatchRouteEvent(wc) {
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(`window.dispatchEvent(new Event('rmrp-route'));`, true).catch(() => {});
}

function clearPageViewCache() {
    for (const entry of pageViewCache.values()) {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && entry.view) {
                mainWindow.removeBrowserView(entry.view);
            }
            if (entry.view?.webContents && !entry.view.webContents.isDestroyed()) {
                entry.view.webContents.destroy();
            }
        } catch {
            /* ignore */
        }
    }
    pageViewCache.clear();
    activePageView = null;
    activePageRoute = null;
}

function loadWebContentsPage(wc, route, depth = 0) {
    if (!wc || wc.isDestroyed()) return;
    const { pathPart, cleanRoute } = normalizeAppRoute(route);
    const targetUrl = buildAppPageUrl(cleanRoute);
    const ses = wc.session;

    let httpGuard;
    const detachHttpGuard = () => {
        if (httpGuard) {
            try { ses.webRequest.onCompleted.removeListener(httpGuard); } catch { /* */ }
            httpGuard = null;
        }
    };

    const failHandler = (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (wc.isDestroyed()) return;
        if (errorCode === -3 || errorCode === 0) return;
        if (isMainFrame === false) return;
        detachHttpGuard();
        console.error(`⚠️ Не удалось загрузить /${pathPart} (${errorCode} ${errorDescription})`);
        loadOfflinePage(wc, 'server');
    };

    const finishHandler = () => {
        if (wc.isDestroyed()) return;
        detachHttpGuard();
        wc.removeListener('did-fail-load', failHandler);
        setImmediate(() => {
            if (wc.isDestroyed()) return;
            wc.executeJavaScript(
                `(document.body && document.body.innerText ? document.body.innerText : '').trim().slice(0, 300)`,
                true,
            ).then((snippet) => {
                const looksLikeJson404 = /^\s*\{/.test(snippet)
                    && /"statusCode"\s*:\s*404/.test(snippet)
                    && /"message"\s*:/.test(snippet);
                if (!looksLikeJson404) {
                    dispatchRouteEvent(wc);
                    return;
                }
                if (depth < 1 && pathPart !== 'main') {
                    loadWebContentsPage(wc, 'main', depth + 1);
                    return;
                }
                loadOfflinePage(wc, 'server');
            }).catch(() => dispatchRouteEvent(wc));
        });
    };

    httpGuard = (details) => {
        if (wc.isDestroyed()) return;
        if (details.resourceType !== 'mainFrame') return;
        if (!details.url || !details.url.startsWith(SERVER_URL)) return;
        if (details.statusCode >= 400) {
            detachHttpGuard();
            wc.removeListener('did-fail-load', failHandler);
            if (details.statusCode >= 500 && depth < 3) {
                setTimeout(() => loadWebContentsPage(wc, route, depth + 1), 1200 * (depth + 1));
                return;
            }
            if (depth < 1 && pathPart !== 'main' && details.statusCode === 404) {
                loadWebContentsPage(wc, 'main', depth + 1);
                return;
            }
            loadOfflinePage(wc, 'server');
        }
    };

    ses.webRequest.onCompleted(httpGuard);
    wc.once('did-fail-load', failHandler);
    wc.once('did-finish-load', finishHandler);

    if (depth === 0 && !ALLOWED_APP_ROUTES.has(pathPart.split('/')[0])) {
        wc.loadURL(`${SERVER_URL}/main`);
        return;
    }
    wc.loadURL(targetUrl);
}

function ensurePageView(route) {
    const { pathPart, cleanRoute } = normalizeAppRoute(route);
    const cacheKey = pathPart;
    const existing = pageViewCache.get(cacheKey);
    if (existing?.ready) return Promise.resolve(existing);

    if (existing?.loading) return existing.loading;

    const view = new BrowserView({ webPreferences: baseWebPreferences() });
    attachExternalLinkHandler(view.webContents);

    const entry = { view, ready: false, loading: null };
    pageViewCache.set(cacheKey, entry);

    entry.loading = new Promise((resolve, reject) => {
        const wc = view.webContents;
        const onReady = () => {
            wc.removeListener('did-fail-load', onFail);
            entry.ready = true;
            entry.loading = null;
            resolve(entry);
        };
        const onFail = () => {
            wc.removeListener('did-finish-load', onReady);
            entry.loading = null;
            pageViewCache.delete(cacheKey);
            reject(new Error(`load failed: ${cleanRoute}`));
        };
        wc.once('did-finish-load', onReady);
        wc.once('did-fail-load', onFail);
        loadWebContentsPage(wc, cleanRoute);
    });

    return entry.loading;
}

async function switchMainAppPage(route, depth = 0) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { pathPart } = normalizeAppRoute(route);

    if (depth === 0 && pathPart === activePageRoute && activePageView) {
        layoutActivePageView();
        dispatchRouteEvent(activePageView.webContents);
        return;
    }

    if (depth === 0) {
        if (pathPart === 'maintenance') startMaintenanceWatch();
        else stopMaintenanceWatch();
    }

    try {
        const entry = await ensurePageView(route);
        if (activePageView && activePageView !== entry.view) {
            try { mainWindow.removeBrowserView(activePageView); } catch { /* ignore */ }
        }
        mainWindow.addBrowserView(entry.view);
        activePageView = entry.view;
        activePageRoute = pathPart;
        applyPageViewThrottling(entry.view);
        layoutActivePageView();
        setImmediate(() => dispatchRouteEvent(entry.view.webContents));
    } catch (err) {
        console.error(`⚠️ switchMainAppPage /${pathPart}:`, err.message);
        if (depth < 1 && pathPart !== 'main') {
            await switchMainAppPage('main', depth + 1);
        }
    }
}

function drainPrefetchQueue() {
    if (prefetchActive >= PREFETCH_MAX_CONCURRENT) return;
    const route = prefetchQueue.shift();
    if (!route) return;
    prefetchActive += 1;
    ensurePageView(route)
        .catch(() => {})
        .finally(() => {
            prefetchActive -= 1;
            drainPrefetchQueue();
        });
}

function enqueuePagePrefetch(route) {
    if (!route || route === activePageRoute || prefetchQueue.includes(route)) return;
    prefetchQueue.push(route);
    drainPrefetchQueue();
}

function schedulePagePrefetch(startRoute) {
    prefetchQueue = [];
    let delay = PREFETCH_START_DELAY_MS;
    for (const route of PREFETCH_ROUTES) {
        if (route === startRoute) continue;
        setTimeout(() => enqueuePagePrefetch(route), delay);
        delay += PREFETCH_STEP_MS;
    }
}

function loadAppPage(win, route, depth = 0) {
    if (win === mainWindow) {
        switchMainAppPage(route, depth).catch((err) => {
            console.error('⚠️ loadAppPage(main):', err.message);
        });
        return;
    }
    if (!win || win.isDestroyed()) return;
    loadWebContentsPage(win.webContents, route, depth);
}

// ==================== ЭКРАН ЗАГРУЗКИ (SPLASH) ====================
// Занимает 9.69% площади экрана и НЕ находится поверх остальных окон — это лишь этап
// инициализации (проверка сети, целостности файлов, предзагрузка законодательства).
function createSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) return;

    const { width, height } = getWindowSizeForAreaFraction(SPLASH_AREA_FRACTION);

    splashWindow = new BrowserWindow({
        width,
        height,
        frame: false,
        resizable: false,
        alwaysOnTop: false, // на этапе загрузки окно НЕ должно быть поверх остальных окон
        backgroundColor: '#0a0a0a',
        icon: getWindowIcon(),
        webPreferences: baseWebPreferences()
    });
    applyWindowIcon(splashWindow);

    splashWindow.loadFile(LOCAL_PAGES.splash());
    attachExternalLinkHandler(splashWindow);

    // Запускаем стартовую последовательность только после того, как splash.html реально
    // отрисовался — иначе первые события прогресса могут "уйти в никуда" до того, как
    // страница успеет подписаться на них.
    splashWindow.webContents.once('did-finish-load', () => {
        beginStartupSequence();
    });
}

// Запускает (или перезапускает — например, по кнопке "Повторить" на offline.html) полную
// стартовую последовательность в текущем окне загрузки.
function beginStartupSequence() {
    if (!splashWindow || splashWindow.isDestroyed()) return;

    runStartupSequence((data) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('startup-progress', data);
        }
    }).then(({ networkError, updatedCore, failReason, reason }) => {
        if (!splashWindow || splashWindow.isDestroyed()) return;

        if (networkError) {
            const q = new URLSearchParams({
                reason: failReason || reason || 'internet',
                server: SERVER_URL,
            }).toString();
            splashWindow.loadFile(LOCAL_PAGES.offline(), { search: `?${q}` });
            return;
        }

        if (updatedCore) {
            // Обновились ключевые файлы (main.js/preload.js) — они применятся только после
            // полного перезапуска процесса Electron, поэтому перезапускаем приложение целиком.
            logAction('Система', 'Обновлены ключевые файлы приложения — требуется перезапуск');
            app.relaunch();
            app.exit(0);
            return;
        }

        createMainWindow();
    }).catch((err) => {
        console.error('⚠️ Ошибка стартовой проверки — запуск прерван:', err);
        if (splashWindow && !splashWindow.isDestroyed()) {
            const q = new URLSearchParams({
                reason: 'integrity',
                server: SERVER_URL,
                detail: String(err?.message || err || '').slice(0, 200),
            }).toString();
            splashWindow.loadFile(LOCAL_PAGES.offline(), { search: `?${q}` });
        }
    });
}

// ==================== ОСНОВНОЕ ОКНО ПРИЛОЖЕНИЯ ====================
// Занимает 56.71% площади экрана и работает в режиме "поверх всех окон" — создаётся только
// после успешного завершения загрузочной последовательности, и заменяет собой splash-окно.
async function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) return;

    const { width, height } = getMainWindowSize();

    const sizeMode = getWindowSizeMode();

    mainWindow = new BrowserWindow({
        width,
        height,
        show: false, // показываем только после ready-to-show, чтобы не было двух окон одновременно со splash
        frame: false,
        thickFrame: process.platform === 'win32',
        resizable: sizeMode === 'floating',
        minWidth: MIN_MAIN_W,
        minHeight: MIN_MAIN_H,
        alwaysOnTop: true, // основное окно всегда поверх остальных (включая игру)
        movable: true,
        backgroundColor: '#111111',
        icon: getWindowIcon(),
        webPreferences: baseWebPreferences()
    });
    applyWindowIcon(mainWindow);

    try {
        mainWindow.setMovable(true);
    } catch {
        /* ignore */
    }

    // Плавающий: запоминаем размер при изменении; фиксированный — только по «Сохранить» / при выходе
    mainWindow.on('will-resize', (event) => {
        if (mainWindowDragActive) event.preventDefault();
    });
    mainWindow.on('resize', () => {
        if (mainWindowDragActive && windowDragState) {
            const { win, lockedWidth, lockedHeight } = windowDragState;
            if (win && !win.isDestroyed()) {
                try {
                    const [w, h] = win.getSize();
                    if (w !== lockedWidth || h !== lockedHeight) {
                        win.setSize(lockedWidth, lockedHeight, false);
                    }
                } catch {
                    /* ignore */
                }
            }
            return;
        }
        if (getWindowSizeMode() === 'floating') schedulePersistMainWindowSize();
    });
    mainWindow.on('focus', () => {
        bumpMaintenanceWatchSoon();
    });
    mainWindow.on('close', () => {
        // Перед закрытием — зафиксировать текущее разрешение для следующего запуска
        persistMainWindowSizeFromWindow();
    });

    const startPage = await resolveStartPage(true);
    mainWindow.loadURL('about:blank');
    attachExternalLinkHandler(mainWindow);
    mainWindow.on('resize', layoutActivePageView);
    loadAppPage(mainWindow, startPage);

    // Сначала закрываем splash, потом показываем main — на экране всегда только одно окно.
    mainWindow.once('ready-to-show', () => {
        applyWindowIcon(mainWindow);
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            applyWindowSizeModeToMainWindow();
            mainWindow.show();
            mainWindow.focus();
            applyStoredWindowOpacity();
            applyStoredGhostModeIfAllowed();
            schedulePagePrefetch(startPage);
            if (startPage !== 'maintenance' && startPage !== 'reg') {
                setImmediate(() => {
                    hydrateSessionFromServer().catch(() => {});
                });
            }
        }
    });

    // Регистрируем хоткеи из хранилища (по умолчанию F3, переназначается в setting.html)
    // + пользовательские бинды из binder.html
    registerAllGlobalShortcuts();

    // Восстанавливаем отсчёт таймеров (time.html), которые были запущены и не успели
    // сработать до предыдущего закрытия приложения
    rescheduleStoredTimers();
}

// === ТРЕКЕР ОНЛАЙНА (лёгкий: tasklist раз в 5 с, счётчик секунд — в памяти) ===
let secondsAccumulator = 0;
let lastGameRunning = false;
let gameProcessCheckBusy = false;
const GAME_TRACKER_PROBE_MS = 5000;
const GAME_TRACKER_TICK_MS = 1000;

function getTodayDateString() {
    return formatLocalDateString(new Date());
}

function probeGameProcesses() {
    if (gameProcessCheckBusy) return;
    gameProcessCheckBusy = true;
    execFile('tasklist', ['/NH', '/FO', 'CSV'], { windowsHide: true, maxBuffer: 1024 * 512 }, (err, stdout) => {
        gameProcessCheckBusy = false;
        if (err || !stdout) return;
        const data = stdout.toLowerCase();
        lastGameRunning =
            data.includes('gta5.exe') ||
            data.includes('ragemp_v.exe') ||
            data.includes('rage multiplayer') ||
            data.includes('gta5_enhanced.exe');
    });
}

setInterval(probeGameProcesses, GAME_TRACKER_PROBE_MS);
setImmediate(probeGameProcesses);

setInterval(() => {
    if (!lastGameRunning) {
        if (secondsAccumulator > 0) secondsAccumulator = 0;
        return;
    }

    secondsAccumulator += 1;
    if (secondsAccumulator < 60) return;
    secondsAccumulator = 0;

    const todayStr = getTodayDateString();
    const currentHour = new Date().getHours();
    let onlineStorage = store.get('rmrp_online_history') || {};
    if (!onlineStorage[todayStr]) {
        onlineStorage[todayStr] = Array(24).fill(0);
    }

    if (onlineStorage[todayStr][currentHour] >= 60) return;

    onlineStorage[todayStr][currentHour] += 1;
    store.set('rmrp_online_history', onlineStorage);

    const totalTodayMinutes = onlineStorage[todayStr].reduce((sum, m) => sum + (m || 0), 0);
    const streakInfo = recomputeAndStoreStreak();

    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
        && activePageRoute === 'online' && activePageView?.webContents
        && !activePageView.webContents.isDestroyed()) {
        setImmediate(() => {
            if (!activePageView?.webContents || activePageView.webContents.isDestroyed()) return;
            activePageView.webContents.send('sync-online-ui', {
                streakDays: streakInfo.currentStreak || 0,
                todayMinutes: totalTodayMinutes,
                justQualified: !!streakInfo.justQualified,
            });
        });
    }

    if (totalTodayMinutes % 5 === 0) {
        sendTelemetryEvent('daily_progress', {
            streakDays: streakInfo.currentStreak || 0,
            onlineMinutesToday: totalTodayMinutes,
        });
    }
}, GAME_TRACKER_TICK_MS);

// Отдаем историю онлайна из хранилища по безопасному запросу фронтенда
ipcMain.handle('get-online-history', () => {
    return store.get('rmrp_online_history') || {};
});

// Актуальная серия дней (пересчёт по онлайну ≥ 1 час/день)
ipcMain.handle('get-streak', () => {
    const data = recomputeAndStoreStreak();
    return {
        currentStreak: data.currentStreak || 0,
        minMinutesRequired: STREAK_MIN_MINUTES,
        todayMinutes: data.todayMinutes || 0,
        lastQualifiedDate: data.lastQualifiedDate || null,
        qualifiesToday: (data.todayMinutes || 0) >= STREAK_MIN_MINUTES,
    };
});
// === АВТОЗАПУСК ПРИЛОЖЕНИЯ ПРИ СТАРТЕ СИСТЕМЫ ===
ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-autostart', (event, value) => {
    try {
        app.setLoginItemSettings({ openAtLogin: !!value });
        logAction('Настройки', `Автозапуск при старте системы ${value ? 'включён' : 'выключен'}`);
        return { success: true, enabled: !!value };
    } catch (error) {
        console.error('Не удалось изменить автозапуск:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('create-desktop-shortcut', () => {
    if (process.platform !== 'win32') {
        return { success: false, error: 'Доступно только в Windows' };
    }
    try {
        const shortcutPath = path.join(app.getPath('desktop'), 'RMRP Helper.lnk');
        const launcherVbs = path.join(__dirname, 'RMRP Helper.vbs');
        const iconPath = [
            path.join(process.resourcesPath, 'app.ico'),
            resolveResourcePath('build', 'icons', 'icon.ico'),
            getAppIconPath(),
        ].find((p) => fs.existsSync(p)) || getAppIconPath();

        let options;
        if (app.isPackaged) {
            options = {
                target: process.execPath,
                cwd: path.dirname(process.execPath),
                description: 'RMRP Helper',
                icon: iconPath,
                iconIndex: 0,
                appUserModelId: 'com.rmrphelper.app',
            };
        } else if (fs.existsSync(launcherVbs)) {
            options = {
                target: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe'),
                args: `"${launcherVbs}"`,
                cwd: __dirname,
                description: 'RMRP Helper',
                icon: iconPath,
                iconIndex: 0,
                appUserModelId: 'com.rmrphelper.app',
            };
        } else {
            options = {
                target: process.execPath,
                args: `"${__dirname}"`,
                cwd: __dirname,
                description: 'RMRP Helper',
                icon: iconPath,
                iconIndex: 0,
                appUserModelId: 'com.rmrphelper.app',
            };
        }

        const operation = fs.existsSync(shortcutPath) ? 'update' : 'create';
        const ok = shell.writeShortcutLink(shortcutPath, operation, options);
        if (!ok) {
            return { success: false, error: 'Не удалось создать ярлык' };
        }
        logAction('Настройки', 'Создан ярлык на рабочем столе');
        return { success: true, path: shortcutPath };
    } catch (error) {
        console.error('create-desktop-shortcut:', error);
        return { success: false, error: error.message };
    }
});

// === ГОРЯЧИЕ КЛАВИШИ ===
ipcMain.handle('get-hotkeys', () => getStoredHotkeys());

// === РП ОТЫГРОВКА ЖЕТОНА (setting.html) ===
// Хранится в main-процессе (не localStorage), т.к. хоткей rpToken глобальный и должен
// печатать актуальный текст, даже если страница "Настройки" сейчас не открыта.
ipcMain.handle('get-rp-token', () => getStoredRpToken());
ipcMain.handle('set-rp-token', (event, payload) => {
    const token = setStoredRpToken(payload);
    scheduleSyncPush();
    return { success: true, token };
});

ipcMain.handle('set-hotkey', (event, id, accelerator, force = false) => {
    if (!id || !accelerator || typeof accelerator !== 'string') {
        return { success: false, error: 'Некорректные данные комбинации' };
    }
    if (!Object.keys(DEFAULT_HOTKEYS).includes(id)) {
        return { success: false, error: 'Неизвестный идентификатор комбинации' };
    }

    // Конфликт с другим системным хоткеем или с биндом из binder.html
    const hotkeys = getStoredHotkeys();
    const clashHotkeyId = Object.keys(hotkeys).find(otherId => otherId !== id && hotkeys[otherId] === accelerator);
    const clashBind = getStoredBinds().find(b => b.hotkey === accelerator);

    if ((clashHotkeyId || clashBind) && !force) {
        return {
            success: false,
            error: clashBind
                ? `Комбинация уже занята биндом "${clashBind.name}"`
                : `Комбинация уже занята другим системным хоткеем ("${SYSTEM_HOTKEY_LABELS[clashHotkeyId] || clashHotkeyId}")`,
            conflict: clashBind
                ? { ownerType: 'binder', ownerId: clashBind.id, ownerName: clashBind.name }
                : { ownerType: 'settings', ownerId: clashHotkeyId, ownerName: SYSTEM_HOTKEY_LABELS[clashHotkeyId] || clashHotkeyId }
        };
    }

    // Проверяем валидность комбинации отдельной пробной регистрацией, ДО того как сохранить её —
    // Electron может как вернуть false, так и выбросить исключение на некорректном акселераторе
    globalShortcut.unregisterAll();
    let isValid = false;
    try {
        isValid = globalShortcut.register(accelerator, () => {});
    } catch (err) {
        isValid = false;
    }
    globalShortcut.unregisterAll();

    if (!isValid) {
        scheduleRegisterAllGlobalShortcuts(); // возвращаем прежние хоткеи и бинды на место
        return { success: false, error: 'Эта комбинация недоступна или уже занята другой программой' };
    }

    // force=true — атомарно отбираем клавишу у прежнего владельца
    if (force && clashBind) {
        const updatedBinds = getStoredBinds().map(b => b.id === clashBind.id ? { ...b, hotkey: '' } : b);
        store.set('rmrp_binds', updatedBinds);
    }
    if (force && clashHotkeyId) {
        hotkeys[clashHotkeyId] = DEFAULT_HOTKEYS[clashHotkeyId];
    }

    hotkeys[id] = accelerator;
    store.set('rmrp_hotkeys', hotkeys);
    scheduleRegisterAllGlobalShortcuts();
    logAction('Настройки', 'Назначена новая комбинация клавиш', { id, accelerator, force });
    scheduleSyncPush();

    return { success: true };
});

// Временное глушение ВСЕХ глобальных хоткеев (биндов и системных) — используется на время
// записи новой комбинации на binder.html/settings.html, чтобы уже занятая клавиша не
// срабатывала параллельно с тем, что пользователь вводит её как новую комбинацию.
ipcMain.handle('suspend-global-shortcuts', () => {
    globalShortcut.unregisterAll();
    return { success: true };
});

ipcMain.handle('resume-global-shortcuts', () => {
    scheduleRegisterAllGlobalShortcuts();
    return { success: true };
});


// === БИНДЕР: МАКРОСЫ ПО ГОРЯЧИМ КЛАВИШАМ (binder.html) ===
ipcMain.handle('get-binder-capabilities', async () => {
    const plus = await fetchHelperPlusStatus();
    return {
        typingAvailable: process.platform === 'win32',
        isHelperPlus: !!plus.isHelperPlus,
        variables: binderRuntime.BINDER_VARIABLES_META,
        maxSteps: plus.isHelperPlus ? binderRuntime.BINDER_PLUS_MAX_STEPS : binderRuntime.BINDER_FREE_MAX_STEPS,
        maxBinds: plus.isHelperPlus ? null : binderRuntime.BINDER_FREE_MAX_BINDS,
    };
});

ipcMain.handle('preview-bind-text', async (_event, text) => {
    const plus = await fetchHelperPlusStatus();
    const raw = String(text || '');
    if (!plus.isHelperPlus) return { text: raw, expanded: false };
    const social = await fetchBinderSocialProfile();
    const ctx = binderRuntime.buildVariableContext(store.get('rmrpUserData') || {}, social);
    return { text: binderRuntime.expandBinderVariables(raw, ctx), expanded: true };
});

ipcMain.handle('get-binds', () => getStoredBinds().map((b) => binderRuntime.migrateBindRecord(b)));

ipcMain.handle('save-binds', async (event, binds, force = false) => {
    if (!Array.isArray(binds)) {
        return { success: false, error: 'Некорректные данные биндов' };
    }

    const plusStatus = await fetchHelperPlusStatus();
    const isPlus = !!plusStatus.isHelperPlus;
    const maxSteps = isPlus ? binderRuntime.BINDER_PLUS_MAX_STEPS : binderRuntime.BINDER_FREE_MAX_STEPS;
    const maxBinds = isPlus ? Infinity : binderRuntime.BINDER_FREE_MAX_BINDS;

    // Простая валидация формы каждого бинда — не доверяем слепо тому, что пришло со страницы
    const sanitized = binds
        .filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string')
        .map((b) => {
            const migrated = binderRuntime.migrateBindRecord(b);
            const steps = migrated.steps.slice(0, maxSteps).map((s) => ({
                text: String(s.text).slice(0, 500),
                autoSend: !!s.autoSend,
            })).filter((s) => s.text);
            return {
                id: b.id,
                name: String(b.name).slice(0, 60),
                description: String(b.description || '').slice(0, 200),
                macro: steps[0]?.text || '',
                steps,
                stepDelayMs: Math.min(60000, Math.max(0, Number(migrated.stepDelayMs) || 1200)),
                category: String(b.category || 'general'),
                icon: String(b.icon || 'bolt'),
                hotkey: typeof b.hotkey === 'string' ? b.hotkey : '',
                autoSend: !!b.autoSend,
                openChat: b.openChat !== false,
                enabled: b.enabled !== false,
                createdAt: b.createdAt || new Date().toISOString(),
            };
        })
        .filter((b) => b.steps.length > 0);

    if (sanitized.length > maxBinds) {
        return {
            success: false,
            error: `Лимит биндов: ${binderRuntime.BINDER_FREE_MAX_BINDS}. Оформите Helper+ для безлимита.`,
        };
    }

    // force=true — перезапись: у старших биндов снимаем hotkey, оставляем у последнего в списке
    if (force) {
        const lastOwnerByHotkey = new Map();
        for (const b of sanitized) {
            if (b.hotkey) lastOwnerByHotkey.set(b.hotkey, b.id);
        }
        for (const b of sanitized) {
            if (b.hotkey && lastOwnerByHotkey.get(b.hotkey) !== b.id) {
                b.hotkey = '';
            }
        }
    }

    // Проверяем, что среди присланных биндов нет дублирующихся горячих клавиш
    const seenHotkeys = new Map();
    for (const b of sanitized) {
        if (!b.hotkey) continue;
        if (seenHotkeys.has(b.hotkey)) {
            return { success: false, error: `Комбинация ${b.hotkey} назначена сразу на два бинда` };
        }
        seenHotkeys.set(b.hotkey, b.id);
    }

    // Конфликты с системными хоткеями (settings.html)
    const hotkeys = getStoredHotkeys();
    const clashes = sanitized
        .filter(b => b.hotkey)
        .map(b => ({ bindId: b.id, hotkeyId: Object.keys(hotkeys).find(id => hotkeys[id] === b.hotkey) }))
        .filter(c => c.hotkeyId);

    if (clashes.length && !force) {
        const first = clashes[0];
        return {
            success: false,
            error: `Комбинация уже занята системным хоткеем ("${SYSTEM_HOTKEY_LABELS[first.hotkeyId] || first.hotkeyId}")`,
            conflict: { ownerType: 'settings', ownerId: first.hotkeyId, ownerName: SYSTEM_HOTKEY_LABELS[first.hotkeyId] || first.hotkeyId, bindId: first.bindId }
        };
    }

    if (force && clashes.length) {
        for (const c of clashes) hotkeys[c.hotkeyId] = DEFAULT_HOTKEYS[c.hotkeyId];
        store.set('rmrp_hotkeys', hotkeys);
    }

    store.set('rmrp_binds', sanitized);
    scheduleRegisterAllGlobalShortcuts();
    logAction('Биндер', 'Список биндов обновлён', { count: sanitized.length, force });
    scheduleSyncPush();

    return { success: true, typingAvailable: process.platform === 'win32' };
});

// ==================== ЗВУК ЗАВЕРШЕНИЯ ТАЙМЕРА (общая настройка, setting.html) ====================
// Список звуков — это .wav файлы, которые лежат в папке sounds/ рядом с main.js (упаковываются
// в сборку автоматически, т.к. попадают под files: ["**/*"] в package.json → build).
// Раньше сигнал по завершению таймера играл Web Audio API прямо на открытой странице — из-за
// этого он был слышен только пока окно RMRP Helper реально существовало и не был гарантированно
// слышен, если пользователь был в другом окне (игра, браузер и т.д.). Теперь звук проигрывает
// сама операционная система (через короткий системный процесс), поэтому он звучит так же, как
// звук любого другого приложения — независимо от того, какое окно сейчас активно у пользователя,
// и даже если окно RMRP Helper свёрнуто.
const TIMER_SOUNDS = [
    { id: 'classic', label: 'Классический', desc: 'Короткий двойной сигнал' },
    { id: 'chime',   label: 'Колокольчик',  desc: 'Мягкий восходящий перезвон' },
    { id: 'digital', label: 'Цифровой',     desc: 'Быстрый тройной бип' },
    { id: 'bell',    label: 'Гонг',         desc: 'Тёплый одиночный удар с обертонами' },
    { id: 'alert',   label: 'Тревога',      desc: 'Настойчивый чередующийся сигнал' }
];
const DEFAULT_TIMER_SOUND = 'classic';

function isValidTimerSoundId(id) {
    return TIMER_SOUNDS.some((s) => s.id === id);
}

function getTimerSoundChoice() {
    const saved = store.get('rmrp_timer_sound');
    return isValidTimerSoundId(saved) ? saved : DEFAULT_TIMER_SOUND;
}

function setTimerSoundChoice(id) {
    if (!isValidTimerSoundId(id)) return false;
    store.set('rmrp_timer_sound', id);
    return true;
}

/** Resolve .wav on disk (dev, asar, asar.unpacked). */
function resolveSoundFile(soundId) {
    const id = isValidTimerSoundId(soundId) ? soundId : DEFAULT_TIMER_SOUND;
    const resolved = resolveAppReadPath(path.join('sounds', `${id}.wav`));
    try {
        if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
        /* ignore */
    }
    return null;
}

/**
 * Copy out of asar (if needed) so OS players can open the file.
 * Returns a real filesystem path.
 */
function materializeSoundFile(soundId) {
    const src = resolveSoundFile(soundId);
    if (!src) return null;
    // Already a real path outside asar
    if (!src.includes(`${path.sep}app.asar${path.sep}`) && !src.includes('/app.asar/')) {
        return src;
    }
    try {
        const tmpDir = path.join(app.getPath('temp'), 'rmrp-helper-sounds');
        fs.mkdirSync(tmpDir, { recursive: true });
        const dest = path.join(tmpDir, path.basename(src));
        // Refresh if missing or size differs
        let needCopy = !fs.existsSync(dest);
        if (!needCopy) {
            try {
                needCopy = fs.statSync(dest).size !== fs.statSync(src).size;
            } catch {
                needCopy = true;
            }
        }
        if (needCopy) fs.copyFileSync(src, dest);
        return dest;
    } catch (err) {
        logAction('Таймеры', 'Не удалось извлечь звук из asar', { error: err.message, src });
        return src;
    }
}

// Проигрывает .wav файл силами ОС. Промис резолвится после окончания звука.
function playTimerSound(soundId) {
    const id = isValidTimerSoundId(soundId) ? soundId : DEFAULT_TIMER_SOUND;
    const filePath = materializeSoundFile(id);

    return new Promise((resolve) => {
        if (!filePath || !fs.existsSync(filePath)) {
            logAction('Таймеры', 'Файл звука не найден', { soundId: id, filePath, dirname: __dirname });
            resolve({ success: false, error: 'file_not_found' });
            return;
        }

        const onDone = (err) => {
            if (err) {
                logAction('Таймеры', 'Не удалось воспроизвести звук таймера', {
                    error: err.message || String(err),
                    filePath,
                });
                resolve({ success: false, error: err.message || 'play_failed' });
            } else {
                resolve({ success: true });
            }
        };

        if (process.platform === 'win32') {
            // Avoid quote/path issues: pass path as base64 to PowerShell
            const b64 = Buffer.from(filePath, 'utf8').toString('base64');
            execFile(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-WindowStyle',
                    'Hidden',
                    '-Command',
                    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $sp = New-Object System.Media.SoundPlayer; $sp.SoundLocation = $p; $sp.Load(); $sp.PlaySync();`,
                ],
                { windowsHide: true, timeout: 30000 },
                onDone,
            );
        } else if (process.platform === 'darwin') {
            execFile('afplay', [filePath], { timeout: 30000 }, onDone);
        } else {
            execFile('paplay', [filePath], { timeout: 30000 }, (err) => {
                if (err) execFile('aplay', [filePath], { timeout: 30000 }, onDone);
                else resolve({ success: true });
            });
        }
    });
}

ipcMain.handle('get-timer-sound-settings', () => {
    return { soundId: getTimerSoundChoice(), sounds: TIMER_SOUNDS };
});

ipcMain.handle('set-timer-sound', (event, soundId) => {
    if (!setTimerSoundChoice(soundId)) {
        return { success: false, error: 'Неизвестный звук' };
    }
    logAction('Таймеры', 'Изменён звук завершения таймера', { soundId });
    scheduleSyncPush();
    return { success: true, soundId: getTimerSoundChoice() };
});

ipcMain.handle('preview-timer-sound', async (event, soundId) => {
    const result = await playTimerSound(soundId);
    return result && typeof result === 'object' ? result : { success: true };
});

// ==================== ТАЙМЕРЫ (time.html) ====================
// Живут в main-процессе (не в renderer'е): mainWindow у нас один и тот же на всё приложение,
// он просто перезагружает разные .html при переходах по сайдбару — значит, если таймер завели
// на time.html и ушли на main.html, setTimeout внутри старой страницы уже уничтожен вместе с её
// JS-контекстом. Поэтому отсчёт и срабатывание таймера должны жить здесь и переживать переходы
// между страницами (и, за счёт electron-store, даже перезапуск самого приложения).
const timerHandles = new Map(); // id -> Timeout handle

function getStoredTimers() {
    return store.get('rmrp_timers') || [];
}

function persistTimers(timers) {
    store.set('rmrp_timers', timers);
    scheduleSyncPush();
}

function broadcastTimersUpdated() {
    const timers = getStoredTimers();
    BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.webContents.send('timers-updated', timers);
    });
}

// Системное уведомление (Windows Action Center, всплывает справа снизу) — работает независимо
// от того, какая страница сейчас открыта в mainWindow, и даже если окно свёрнуто.
function fireTimerNotification(timer) {
    if (!Notification.isSupported()) {
        logAction('Таймеры', 'Системные уведомления не поддерживаются на этой машине');
        return;
    }
    const notification = new Notification({
        title: 'RMRP Helper — таймер завершён',
        body: timer.name || 'Время вышло',
        icon: getAppIconPath(),
        // Звук системного уведомления выключен намеренно: мы уже проигрываем выбранный
        // пользователем звук отдельно через playTimerSound() в completeTimer(), и если тут
        // тоже оставить системный "дзынь", получится двойной наложенный сигнал.
        silent: true
    });
    notification.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
    notification.show();
}

function completeTimer(id) {
    const timers = getStoredTimers();
    const timer = timers.find((t) => t.id === id);
    if (!timer || timer.status === 'completed') return;

    timer.status = 'completed';
    timer.endsAt = null;
    timer.remainingSeconds = 0;
    persistTimers(timers);

    if (timerHandles.has(id)) {
        clearTimeout(timerHandles.get(id));
        timerHandles.delete(id);
    }

    logAction('Таймеры', `Таймер "${timer.name}" завершён`);
    if (timer.soundId !== 'silent') {
        playTimerSound(getTimerSoundChoice());
    }
    fireTimerNotification(timer);
    broadcastTimersUpdated();
}

// Ставит/переставляет setTimeout на срабатывание конкретного таймера по его endsAt.
// Если endsAt уже в прошлом (например, приложение было закрыто дольше, чем оставалось времени) —
// завершаем таймер сразу же.
function scheduleTimerCompletion(timer) {
    if (timerHandles.has(timer.id)) {
        clearTimeout(timerHandles.get(timer.id));
        timerHandles.delete(timer.id);
    }
    if (timer.status !== 'running' || !timer.endsAt) return;

    const msLeft = timer.endsAt - Date.now();
    if (msLeft <= 0) {
        completeTimer(timer.id);
        return;
    }
    const handle = setTimeout(() => completeTimer(timer.id), msLeft);
    timerHandles.set(timer.id, handle);
}

// Восстанавливает отсчёт всех таймеров, которые были "running" на момент прошлого закрытия
// приложения — вызывается один раз при старте.
function rescheduleStoredTimers() {
    getStoredTimers().forEach((timer) => {
        if (timer.status === 'running') scheduleTimerCompletion(timer);
    });
}

ipcMain.handle('get-timers', () => getStoredTimers());

ipcMain.handle('start-timer', (event, payload) => {
    const durationSeconds = Math.round(Number(payload && payload.durationSeconds));
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 24 * 3600) {
        return { success: false, error: 'Укажите корректную длительность таймера (от 1 секунды до 24 часов)' };
    }

    const timer = {
        id: 'tm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        name: String((payload && payload.name) || 'Таймер').slice(0, 80),
        durationSeconds,
        remainingSeconds: durationSeconds,
        endsAt: Date.now() + durationSeconds * 1000,
        status: 'running',
        soundId: (payload && payload.soundId) === 'silent' ? 'silent' : 'default',
        createdAt: new Date().toISOString()
    };

    const timers = getStoredTimers();
    timers.push(timer);
    persistTimers(timers);
    scheduleTimerCompletion(timer);
    logAction('Таймеры', `Запущен таймер "${timer.name}"`, { durationSeconds });

    return { success: true, timer };
});

ipcMain.handle('pause-timer', (event, id) => {
    const timers = getStoredTimers();
    const timer = timers.find((t) => t.id === id);
    if (!timer || timer.status !== 'running') return { success: false };

    timer.remainingSeconds = Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000));
    timer.endsAt = null;
    timer.status = 'paused';
    persistTimers(timers);

    if (timerHandles.has(id)) {
        clearTimeout(timerHandles.get(id));
        timerHandles.delete(id);
    }
    return { success: true, timer };
});

ipcMain.handle('resume-timer', (event, id) => {
    const timers = getStoredTimers();
    const timer = timers.find((t) => t.id === id);
    if (!timer || timer.status !== 'paused') return { success: false };

    timer.endsAt = Date.now() + timer.remainingSeconds * 1000;
    timer.status = 'running';
    persistTimers(timers);
    scheduleTimerCompletion(timer);
    return { success: true, timer };
});

ipcMain.handle('cancel-timer', (event, id) => {
    let timers = getStoredTimers();
    if (timerHandles.has(id)) {
        clearTimeout(timerHandles.get(id));
        timerHandles.delete(id);
    }
    timers = timers.filter((t) => t.id !== id);
    persistTimers(timers);
    return { success: true };
});

// Запуск уже существующего (в т.ч. завершённого) таймера заново — сброс на полную
// длительность и статус running, независимо от того, в каком состоянии он был.
ipcMain.handle('restart-timer', (event, id) => {
    const timers = getStoredTimers();
    const timer = timers.find((t) => t.id === id);
    if (!timer) return { success: false };

    timer.remainingSeconds = timer.durationSeconds;
    timer.endsAt = Date.now() + timer.durationSeconds * 1000;
    timer.status = 'running';
    persistTimers(timers);
    scheduleTimerCompletion(timer);
    logAction('Таймеры', `Таймер "${timer.name}" запущен заново`);

    return { success: true, timer };
});

// Редактирование названия/длительности/звука существующего таймера.
ipcMain.handle('edit-timer', (event, id, payload) => {
    const timers = getStoredTimers();
    const timer = timers.find((t) => t.id === id);
    if (!timer) return { success: false, error: 'Таймер не найден' };

    const durationSeconds = Math.round(Number(payload && payload.durationSeconds));
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 24 * 3600) {
        return { success: false, error: 'Укажите корректную длительность таймера (от 1 секунды до 24 часов)' };
    }

    timer.name = String((payload && payload.name) || timer.name).slice(0, 80);
    timer.durationSeconds = durationSeconds;
    timer.soundId = (payload && payload.soundId) === 'silent' ? 'silent' : 'default';

    // Сам отсчёт трогаем аккуратно: если таймер уже шёл — пересчитываем endsAt под новую
    // длительность и планируем завершение заново; если был на паузе или уже завершился —
    // просто обновляем remainingSeconds под новую длительность (завершённый таймер при
    // редактировании возвращается в статус "paused", чтобы его можно было запустить/продолжить).
    if (timer.status === 'running') {
        timer.endsAt = Date.now() + durationSeconds * 1000;
        timer.remainingSeconds = durationSeconds;
        scheduleTimerCompletion(timer);
    } else {
        timer.remainingSeconds = durationSeconds;
        if (timer.status === 'completed') timer.status = 'paused';
    }

    persistTimers(timers);
    logAction('Таймеры', `Таймер "${timer.name}" изменён`);

    return { success: true, timer };
});

// === TELEGRAM-АВТОРИЗАЦИЯ (reg.html) ===
ipcMain.handle('auth-request-login-ticket', async (event, intent) => {
    try {
        const safeIntent = intent === 'register' ? 'register' : 'login';
        const result = await authApiFetch('/auth/telegram/ticket', {
            method: 'POST',
            body: JSON.stringify({ intent: safeIntent }),
        });
        if (!result.ticketId) {
            return { success: false, error: 'Не удалось создать тикет входа' };
        }
        return {
            success: true,
            ticketId: result.ticketId,
            deepLink: result.deepLink,
            clientVerifier: result.clientVerifier,
        };
    } catch (err) {
        return { success: false, error: err.message || 'Сервер недоступен' };
    }
});

ipcMain.handle('auth-poll-login-ticket', async (event, ticketId, clientVerifier) => {
    if (!ticketId) return { status: 'not_found' };
    try {
        const headers = {};
        if (clientVerifier) headers['X-Auth-Ticket-Verifier'] = String(clientVerifier).slice(0, 128);
        const result = await authApiFetch(`/auth/telegram/ticket/${ticketId}`, { headers });
        if (result.status === 'confirmed' && result.refreshToken) {
            // Сначала пишем профиль (с детектом смены аккаунта), потом токены —
            // чтобы не оставить JWT нового пользователя поверх кэша чужих данных.
            if (result.user) {
                persistAuthUser(result.user);
            } else if (result.profileComplete === false) {
                resetLocalUserSession({ keepTelemetryConsent: false });
            }

            saveRefreshToken(result.refreshToken);
            accessToken = result.accessToken || null;

            // Если сервер явно сказал «профиль неполный» — не даём локальному кэшу
            // переопределить onboard (дополнительная страховка к persistAuthUser).
            if (result.profileComplete === false) {
                const cur = store.get('rmrpUserData') || {};
                store.set('rmrpUserData', {
                    ...cur,
                    nickname: '',
                    staticId: '',
                    userTag: '',
                    registered: false,
                    updatedAt: new Date().toISOString(),
                });
            }

            await hydrateSessionFromServer();
            const logMsg = result.redirectedToLogin
                ? 'Регистрация отклонена — аккаунт уже есть, выполнен вход'
                : (result.profileComplete === false
                    ? 'Telegram подтверждён — требуется заполнение профиля'
                    : 'Вход через Telegram подтверждён');
            logAction('Авторизация', logMsg, {
                userId: result.user?.id || null,
                profileComplete: !!result.profileComplete,
            });
            if (mainWindow && !mainWindow.isDestroyed()) {
                // skipProfileFetch=false: resolveStartPage ещё раз сверит профиль с сервером
                const nextPage = result.profileComplete === false
                    ? 'onboard'
                    : await resolveStartPage();
                loadAppPage(mainWindow, nextPage);
            }
        }
        return result;
    } catch (err) {
        return { status: 'error', error: err.message || 'Сервер недоступен' };
    }
});

ipcMain.handle('auth-is-logged-in', async () => ensureAuthSession());

ipcMain.handle('copy-to-clipboard', (event, text) => {
    try {
        clipboard.writeText(String(text ?? ''));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('auth-logout', async () => {
    // Revoke server-side refresh session (best effort)
    try {
        const rt = loadRefreshToken();
        if (rt) {
            await authApiFetch('/auth/telegram/logout', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: rt }),
            });
        }
    } catch {
        /* offline / already invalid */
    }
    clearAuthSession();
    resetLocalUserSession({ keepTelemetryConsent: true });
    clearPageViewCache();
    invalidateMaintenanceGateCache();
    if (mainWindow && !mainWindow.isDestroyed()) {
        loadAppPage(mainWindow, 'reg');
    }
    return { success: true };
});

// === ОНБОРДИНГ ПОСЛЕ TELEGRAM (onboard.html) ===
ipcMain.handle('complete-onboarding', async (event, payload) => {
    if (!payload || typeof payload !== 'object') {
        return { success: false, error: 'Некорректные данные' };
    }
    if (!(await ensureAuthSession())) {
        return { success: false, error: 'Нет авторизации' };
    }

    try {
        const result = await authApiFetch('/users/me/onboarding', {
            method: 'POST',
            body: JSON.stringify({
                nickname: payload.nickname,
                static_id: payload.staticId,
                secret_word: payload.secretWord,
                user_tag: payload.userTag,
            }),
        });

        if (!result || !result.success || !result.user) {
            return { success: false, error: (result && result.error) || 'Не удалось сохранить профиль' };
        }

        persistAuthUser(result.user);
        const previous = store.get('rmrpUserData') || {};
        store.set('rmrpUserData', {
            ...previous,
            // secretWord только локально (сервер его не отдаёт в public profile)
            secretWord: typeof payload.secretWord === 'string' ? payload.secretWord : (previous.secretWord || ''),
            registered: true,
            registeredAt: previous.registeredAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        logAction('Профиль', 'Онбординг завершён', {
            nickname: payload.nickname,
            staticId: payload.staticId,
            userTag: payload.userTag,
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
            const nextPage = await resolveStartPage();
            loadAppPage(mainWindow, nextPage);
        }

        return { success: true, user: result.user };
    } catch (err) {
        return { success: false, error: err.message || 'Сервер недоступен' };
    }
});

ipcMain.handle('change-user-tag', async (event, userTag) => {
    if (!(await ensureAuthSession())) {
        return { success: false, error: 'Нет авторизации' };
    }
    try {
        const result = await authApiFetch('/users/me/tag', {
            method: 'PATCH',
            body: JSON.stringify({ user_tag: userTag }),
        });
        if (!result || !result.success || !result.user) {
            return { success: false, error: (result && result.error) || 'Не удалось сменить тег' };
        }
        persistAuthUser(result.user);
        lastSocialProfileCache = null;
        logAction('Профиль', 'Тег изменён', { userTag: result.user.user_tag });
        return { success: true, user: result.user };
    } catch (err) {
        return { success: false, error: err.message || 'Сервер недоступен' };
    }
});

ipcMain.handle('get-tag-change-info', async () => {
    if (!(await ensureAuthSession())) {
        return { user_tag: null, canChange: false };
    }
    const cached = tagInfoCache.data;
    if (cached && Date.now() - tagInfoCache.at < TAG_INFO_TTL_MS) {
        return cached;
    }
    try {
        const fresh = await authApiFetch('/users/me/tag-info');
        tagInfoCache = { data: fresh, at: Date.now() };
        return fresh;
    } catch (err) {
        if (cached) return cached;
        return { user_tag: null, canChange: false, error: err.message };
    }
});

ipcMain.handle('get-maintenance-status', async () => {
    try {
        const headers = { Accept: 'application/json' };
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        const res = await fetch(`${SERVER_URL}/auth/maintenance/status`, { headers });
        if (!res.ok) return { isActive: false, bypass: false };
        return await res.json();
    } catch {
        return { isActive: false, bypass: false };
    }
});

ipcMain.handle('navigate-to-page', async (event, route) => {
    if (!route || typeof route !== 'string') return { success: false };
    if (mainWindow && !mainWindow.isDestroyed()) {
        const raw = route.replace(/\.html(?=($|\?|#))/, '');
        const hashIdx = raw.indexOf('#');
        const pathAndQuery = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
        const hash = hashIdx >= 0 ? raw.slice(hashIdx) : '';
        const pathPart = pathAndQuery.replace(/^\/+/, '').split('?')[0];
        if (pathPart !== 'maintenance') {
            const maint = await fetchMaintenanceGateCached();
            if (maint) {
                loadAppPage(mainWindow, 'maintenance');
                return { success: true, maintenance: true };
            }
        }
        await switchMainAppPage(pathAndQuery);
        if (hash && activePageView && !activePageView.webContents.isDestroyed()) {
            activePageView.webContents.executeJavaScript(
                `location.hash = ${JSON.stringify(hash.slice(1))}; window.dispatchEvent(new HashChangeEvent('hashchange'));`,
            ).catch(() => {});
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        return { success: true };
    }
    return { success: false };
});

ipcMain.handle('get-account-info', async () => {
    const local = store.get('rmrpUserData') || {};
    const resolvedId = local.userId || getUserIdFromAccessToken() || null;
    const localFallback = {
        id: resolvedId,
        telegram_id: local.telegramId || null,
        deletionPending: false,
        deletionDaysLeft: 0,
        fromCache: true,
    };
    if (!(await ensureAuthSession())) return localFallback;
    try {
        const remote = await authApiFetch('/users/me/account');
        if (remote?.statusCode || remote?.error) {
            if (!resolvedId) {
                const profile = await fetchServerProfile();
                if (profile?.id) {
                    return { ...localFallback, id: profile.id, error: remote.error || remote.message };
                }
            }
            return { ...localFallback, error: remote.error || remote.message };
        }
        if (remote?.id) {
            const previous = store.get('rmrpUserData') || {};
            store.set('rmrpUserData', { ...previous, userId: remote.id });
            return remote;
        }
        return localFallback;
    } catch (err) {
        return { ...localFallback, error: err.message };
    }
});

ipcMain.handle('start-change-telegram', async (event, secretWord) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch('/users/me/change-telegram', {
            method: 'POST',
            body: JSON.stringify({ secret_word: secretWord }),
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('start-change-secret', async (event, newSecretWord) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch('/users/me/change-secret', {
            method: 'POST',
            body: JSON.stringify({ new_secret_word: newSecretWord }),
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('poll-security-ticket', async (event, ticketId) => {
    if (!ticketId || !(await ensureAuthSession())) return { status: 'not_found' };
    try {
        return await authApiFetch(`/users/me/security-ticket/${ticketId}`);
    } catch (err) {
        return { status: 'error', error: err.message };
    }
});

ipcMain.handle('request-account-deletion', async (event, secretWord) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        const result = await authApiFetch('/users/me/delete-request', {
            method: 'POST',
            body: JSON.stringify({ secret_word: String(secretWord || '') }),
        });
        if (!result || result.success === false) {
            return {
                success: false,
                error: result?.error || result?.message || 'Не удалось запланировать удаление',
            };
        }
        return { success: true, account: result.account || null };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cancel-account-deletion', async () => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        const result = await authApiFetch('/users/me/delete-cancel', { method: 'POST' });
        if (!result || result.success === false) {
            return {
                success: false,
                error: result?.error || result?.message || 'Не удалось отменить удаление',
            };
        }
        return { success: true, account: result.account || null };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-social-profile', async () => {
    if (!(await ensureAuthSession())) return lastSocialProfileCache;
    try {
        const profile = await authApiFetch('/users/me/social');
        if (profile && profile.id && !profile.error) {
            lastSocialProfileCache = profile;
            return profile;
        }
        return lastSocialProfileCache || profile;
    } catch (err) {
        return lastSocialProfileCache || { error: err.message };
    }
});

ipcMain.handle('get-public-profile', async (event, ref) => {
    if (!(await ensureAuthSession())) return { error: 'Нет авторизации' };
    const key = String(ref || '').trim();
    if (!key) return { error: 'Не указан пользователь' };
    try {
        return await authApiFetch(`/users/public/${encodeURIComponent(key)}`);
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('update-social-profile', async (event, payload) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        const result = await authApiFetch('/users/me/social', {
            method: 'PATCH',
            body: JSON.stringify(payload || {}),
        });
        if (result?.success && result.profile) {
            lastSocialProfileCache = result.profile;
            tagInfoCache = { data: null, at: 0 };
        }
        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-achievements', async () => {
    const empty = { items: [], unlockedCount: 0, totalCount: 0, points: 0, avatars: [] };
    if (!(await ensureAuthSession())) {
        return { ...empty, error: 'Нет авторизации' };
    }
    try {
        const data = await authApiFetch('/users/me/achievements');
        if (data?.error && !data?.items?.length) {
            return { ...empty, error: data.error || data.message || 'Ошибка сервера' };
        }
        return {
            items: Array.isArray(data?.items) ? data.items : [],
            unlockedCount: Number(data?.unlockedCount) || 0,
            totalCount: Number(data?.totalCount) || (data?.items?.length || 0),
            points: Number(data?.points) || 0,
            achievementPoints: Number(data?.achievementPoints) || 0,
            trainerXp: Number(data?.trainerXp) || 0,
            avatars: data?.avatars || [],
            error: data?.error || null,
        };
    } catch (err) {
        return { ...empty, error: err.message || 'network_error' };
    }
});

ipcMain.handle('get-friends', async () => {
    if (!(await ensureAuthSession())) return { friends: [], acceptedCount: 0 };
    try {
        return await authApiFetch('/users/me/friends');
    } catch (err) {
        return { friends: [], error: err.message };
    }
});

ipcMain.handle('send-friend-request', async (event, userTag) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch('/users/me/friends/request', {
            method: 'POST',
            body: JSON.stringify({ user_tag: userTag }),
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('accept-friend-request', async (event, friendshipId) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch(`/users/me/friends/accept/${friendshipId}`, { method: 'POST' });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('remove-friend', async (event, friendshipId) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch(`/users/me/friends/${friendshipId}`, { method: 'DELETE' });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

function getGhostModeState() {
    return { enabled: !!store.get('rmrp_ghost_mode') };
}

async function fetchHelperPlusStatus() {
    if (!(await ensureAuthSession())) return { isHelperPlus: false, premiumDaysLeft: null };
    try {
        const profile = await authApiFetch('/users/me/social');
        return {
            isHelperPlus: !!profile?.isHelperPlus,
            helperPlusUntil: profile?.helperPlusUntil || null,
            premiumDaysLeft: profile?.premiumDaysLeft ?? null,
            premiumUntilLabel: profile?.premiumUntilLabel || null,
        };
    } catch {
        return { isHelperPlus: false, premiumDaysLeft: null };
    }
}

function destroyTray() {
    if (!tray) return;
    try {
        tray.destroy();
    } catch {
        // ignore
    }
    tray = null;
}

// «Невидимка»: окно остаётся видимым и рабочим для самого пользователя на мониторе.
// Скрываем только от захвата экрана (демонстрация в Zoom/Discord/OBS), из трея и панели задач.
function applyGhostModeToWindow(enabled) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const on = !!enabled;
    mainWindow.setContentProtection(on);
    mainWindow.setSkipTaskbar(on);
    if (on) {
        destroyTray();
        // Явно оставляем окно на экране — режим не должен прятать UI от владельца.
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
    } else if (!tray) {
        createTray();
    }
}

async function applyStoredGhostModeIfAllowed() {
    if (!getGhostModeState().enabled) return;
    const status = await fetchHelperPlusStatus();
    if (status.isHelperPlus) {
        applyGhostModeToWindow(true);
    } else {
        store.set('rmrp_ghost_mode', false);
    }
}

function openFriendsWindow() {
    if (friendsWindow && !friendsWindow.isDestroyed()) {
        friendsWindow.show();
        friendsWindow.focus();
        return friendsWindow;
    }

    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    friendsWindow = new BrowserWindow({
        width: 440,
        height: 640,
        show: false,
        frame: false,
        resizable: true,
        minimizable: true,
        maximizable: false,
        backgroundColor: '#111111',
        parent: parent || undefined,
        icon: getWindowIcon(),
        webPreferences: baseWebPreferences(),
    });
    applyWindowIcon(friendsWindow);

    attachExternalLinkHandler(friendsWindow);
    loadAppPage(friendsWindow, 'friends');

    friendsWindow.once('ready-to-show', () => {
        if (friendsWindow && !friendsWindow.isDestroyed()) {
            friendsWindow.show();
            friendsWindow.focus();
        }
    });

    friendsWindow.on('closed', () => {
        friendsWindow = null;
    });

    return friendsWindow;
}

ipcMain.handle('check-user-tag', async (event, userTag) => {
    try {
        const base = SERVER_URL.replace(/\/$/, '');
        const params = new URLSearchParams({ tag: String(userTag || '') });
        if (await ensureAuthSession()) {
            const me = await fetchServerProfile();
            if (me?.id) params.set('exclude', me.id);
        }
        const lib = base.startsWith('https') ? https : http;
        return await new Promise((resolve) => {
            lib.get(`${base}/tags/check?${params.toString()}`, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch { resolve({ valid: false, available: false, error: 'Ошибка ответа сервера' }); }
                });
            }).on('error', (err) => resolve({ valid: false, available: false, error: err.message }));
        });
    } catch (err) {
        return { valid: false, available: false, error: err.message };
    }
});

ipcMain.handle('upload-profile-media', async (event, payload) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    const kind = payload?.kind === 'banner' ? 'banner' : 'avatar';
    const apiPath = kind === 'banner' ? '/users/me/media/banner' : '/users/me/media/avatar';
    try {
        return await authApiFetch(apiPath, {
            method: 'POST',
            body: JSON.stringify({ data: payload?.data || '', mime: payload?.mime || '' }),
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * Сжимает изображение для аватара/баннера через nativeImage (без sharp).
 * GIF оставляем как есть (анимация). WebP и прочие форматы, которые nativeImage
 * не декодирует — отправляем как есть (с лимитом размера).
 */
function compressProfileImageBuffer(buf, kind, ext) {
    const mimeByExt = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
    };
    const rawMime = mimeByExt[ext] || 'image/jpeg';
    const isGif = ext === '.gif';
    if (isGif) {
        if (buf.length > 2.5 * 1024 * 1024) {
            throw new Error('GIF больше 2.5 МБ — сожмите файл или выберите другой');
        }
        return { data: `data:image/gif;base64,${buf.toString('base64')}`, mime: 'image/gif' };
    }

    let img = null;
    try {
        img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) img = null;
    } catch {
        img = null;
    }

    if (!img) {
        const maxRaw = kind === 'banner' ? 5 * 1024 * 1024 : 2 * 1024 * 1024;
        if (buf.length > maxRaw) {
            throw new Error(`Файл слишком большой (${Math.round(buf.length / 1024)} КБ). Выберите JPG/PNG поменьше.`);
        }
        return { data: `data:${rawMime};base64,${buf.toString('base64')}`, mime: rawMime };
    }

    const maxEdge = kind === 'banner' ? 1600 : 512;
    const { width, height } = img.getSize();
    const scale = Math.min(1, maxEdge / Math.max(width || 1, height || 1));
    let out = img;
    if (scale < 1) {
        out = img.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'best',
        });
    }
    if (ext === '.png' && buf.length < 400 * 1024 && kind === 'avatar') {
        const png = out.toPNG();
        return { data: `data:image/png;base64,${png.toString('base64')}`, mime: 'image/png' };
    }
    const jpeg = out.toJPEG(82);
    return { data: `data:image/jpeg;base64,${jpeg.toString('base64')}`, mime: 'image/jpeg' };
}

/** Pick image only — for crop/preview UI (avatar). Returns data URL, does not upload. */
ipcMain.handle('pick-profile-image', async (event, kindRaw) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    const kind = kindRaw === 'banner' ? 'banner' : 'avatar';
    const { dialog, BrowserWindow: BW } = require('electron');
    const win = BW.fromWebContents(event.sender) || BW.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
        title: kind === 'banner' ? 'Выберите баннер' : 'Выберите аватар',
        properties: ['openFile'],
        filters: [
            {
                name: 'Изображения',
                extensions:
                    kind === 'banner'
                        ? ['jpg', 'jpeg', 'png', 'webp', 'gif']
                        : ['jpg', 'jpeg', 'png', 'webp'],
            },
        ],
    });
    if (result.canceled || !result.filePaths?.[0]) {
        return { success: false, error: 'cancelled', cancelled: true };
    }
    try {
        const filePath = result.filePaths[0];
        const buf = fs.readFileSync(filePath);
        if (buf.length > 12 * 1024 * 1024) {
            return { success: false, error: 'Файл больше 12 МБ' };
        }
        const ext = path.extname(filePath).toLowerCase();
        let mime = 'image/jpeg';
        if (ext === '.png') mime = 'image/png';
        else if (ext === '.webp') mime = 'image/webp';
        else if (ext === '.gif') mime = 'image/gif';
        const data = `data:${mime};base64,${buf.toString('base64')}`;
        return { success: true, data, mime, fileName: path.basename(filePath) };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

/** Native OS file dialog + upload (banner / legacy). Avatar prefers pick + crop in UI. */
ipcMain.handle('pick-and-upload-profile-media', async (event, kindRaw) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    const kind = kindRaw === 'banner' ? 'banner' : 'avatar';
    const { dialog, BrowserWindow: BW } = require('electron');
    const win = BW.fromWebContents(event.sender) || BW.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
        title: kind === 'banner' ? 'Выберите баннер' : 'Выберите аватар',
        properties: ['openFile'],
        filters: [
            { name: 'Изображения', extensions: kind === 'banner' ? ['jpg', 'jpeg', 'png', 'webp', 'gif'] : ['jpg', 'jpeg', 'png', 'webp'] },
        ],
    });
    if (result.canceled || !result.filePaths?.[0]) {
        return { success: false, error: 'cancelled', cancelled: true };
    }
    try {
        const filePath = result.filePaths[0];
        const buf = fs.readFileSync(filePath);
        if (buf.length > 12 * 1024 * 1024) {
            return { success: false, error: 'Файл больше 12 МБ' };
        }
        const ext = path.extname(filePath).toLowerCase();
        const { data, mime } = compressProfileImageBuffer(buf, kind, ext);
        const apiPath = kind === 'banner' ? '/users/me/media/banner' : '/users/me/media/avatar';
        return await authApiFetch(apiPath, {
            method: 'POST',
            body: JSON.stringify({ data, mime }),
        });
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('retry-startup', async () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.loadFile(LOCAL_PAGES.splash());
        splashWindow.webContents.once('did-finish-load', () => beginStartupSequence());
        return { success: true };
    }
    createSplashWindow();
    return { success: true };
});

ipcMain.handle('set-profile-media-url', async (event, payload) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    const kind = payload?.kind === 'banner' ? 'banner' : 'avatar';
    const path = kind === 'banner' ? '/users/me/media/banner-url' : '/users/me/media/avatar-url';
    try {
        return await authApiFetch(path, {
            method: 'POST',
            body: JSON.stringify({ url: payload?.url || '' }),
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-helper-plus-status', async () => fetchHelperPlusStatus());

ipcMain.handle('open-external', async (event, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target) && !/^tg:\/\//i.test(target)) {
        return { success: false, error: 'Недопустимый URL' };
    }
    try {
        await shell.openExternal(target);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-ghost-mode', () => getGhostModeState());

// === Прозрачность основного окна (setting.html) ===
const WINDOW_OPACITY_KEY = 'rmrp_window_opacity';
const MIN_WINDOW_OPACITY = 0.55;
const MAX_WINDOW_OPACITY = 1;

function clampWindowOpacity(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, Math.round(n * 100) / 100));
}

function getStoredWindowOpacity() {
    return clampWindowOpacity(store.get(WINDOW_OPACITY_KEY, 1));
}

function applyStoredWindowOpacity() {
    if (!mainWindow || mainWindow.isDestroyed()) return getStoredWindowOpacity();
    const o = getStoredWindowOpacity();
    try {
        mainWindow.setOpacity(o);
    } catch (err) {
        logAction('Настройки', 'setOpacity failed', { error: err.message });
    }
    // Tell renderer for CSS glass variables
    try {
        mainWindow.webContents.send('window-opacity-changed', o);
    } catch {
        /* ignore */
    }
    return o;
}

ipcMain.handle('get-window-opacity', () => {
    const opacity = getStoredWindowOpacity();
    return { opacity, percent: Math.round(opacity * 100), min: MIN_WINDOW_OPACITY, max: MAX_WINDOW_OPACITY };
});

ipcMain.handle('set-window-opacity', (event, value) => {
    // Accept 0.55–1 or 55–100
    let o = Number(value);
    if (o > 1.5) o = o / 100;
    o = clampWindowOpacity(o);
    store.set(WINDOW_OPACITY_KEY, o);
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.setOpacity(o);
        } catch (err) {
            return { success: false, error: err.message, opacity: o };
        }
        try {
            mainWindow.webContents.send('window-opacity-changed', o);
        } catch {
            /* ignore */
        }
    }
    return { success: true, opacity: o, percent: Math.round(o * 100) };
});

// === Перетаскивание frameless-окна ===
// Только IPC-drag в DIP-координатах (без mix screen/dip). CSS -webkit-app-region отключён на handle.
let lastAppliedZoomFactor = 1;
let windowDragState = null;

function broadcastDragLock(win, locked) {
    if (!win || win.isDestroyed()) return;
    try {
        win.webContents.send('rmrp-drag-lock', !!locked);
    } catch {
        /* ignore */
    }
}

/** Windows thickFrame может ресайзить даже при resizable:false — фиксируем min=max на время drag. */
function lockWindowSizeForDrag(win) {
    const [lockedWidth, lockedHeight] = win.getSize();
    win.setMinimumSize(lockedWidth, lockedHeight);
    win.setMaximumSize(lockedWidth, lockedHeight);
    return { lockedWidth, lockedHeight };
}

function restoreWindowSizeConstraintsAfterDrag(win, wasResizable) {
    if (!win || win.isDestroyed()) return;
    const { width: maxW, height: maxH } = screen.getPrimaryDisplay().workAreaSize;
    win.setMinimumSize(MIN_MAIN_W, MIN_MAIN_H);
    win.setMaximumSize(maxW, maxH);
    if (wasResizable) win.setResizable(true);
}

function stopWindowDrag() {
    if (!windowDragState) return;
    const { win, timer, wasResizable } = windowDragState;
    clearInterval(timer);
    windowDragState = null;
    mainWindowDragActive = false;
    if (win && !win.isDestroyed()) {
        try {
            restoreWindowSizeConstraintsAfterDrag(win, wasResizable);
        } catch {
            /* ignore */
        }
        broadcastDragLock(win, false);
    }
}

function tickWindowDrag() {
    if (!windowDragState) return;
    const { win, offsetDipX, offsetDipY, lockedWidth, lockedHeight } = windowDragState;
    if (!win || win.isDestroyed()) {
        stopWindowDrag();
        return;
    }
    try {
        const cursorDip = screen.screenToDipPoint(screen.getCursorScreenPoint());
        const x = Math.round(cursorDip.x - offsetDipX);
        const y = Math.round(cursorDip.y - offsetDipY);
        const b = win.getBounds();
        if (b.x === x && b.y === y && b.width === lockedWidth && b.height === lockedHeight) return;
        win.setBounds({ x, y, width: lockedWidth, height: lockedHeight }, false);
    } catch (err) {
        console.warn('window-drag-tick:', err.message);
        stopWindowDrag();
    }
}

ipcMain.on('window-drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    stopWindowDrag();
    mainWindowDragActive = true;
    broadcastDragLock(win, true);
    try {
        const wasResizable = win.isResizable();
        if (wasResizable) win.setResizable(false);
        const { lockedWidth, lockedHeight } = lockWindowSizeForDrag(win);
        const cursorDip = screen.screenToDipPoint(screen.getCursorScreenPoint());
        const [winX, winY] = win.getPosition();
        windowDragState = {
            win,
            offsetDipX: cursorDip.x - winX,
            offsetDipY: cursorDip.y - winY,
            wasResizable,
            lockedWidth,
            lockedHeight,
            timer: setInterval(tickWindowDrag, 16),
        };
        tickWindowDrag();
    } catch (err) {
        console.warn('window-drag-start:', err.message);
        stopWindowDrag();
    }
});

ipcMain.on('window-drag-stop', () => {
    stopWindowDrag();
});

app.on('before-quit', () => stopWindowDrag());

// === ZoomFactor вместо CSS zoom (не ломает drag) ===
ipcMain.handle('set-zoom-factor', (event, factor) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false };
    // Electron/Windows: setZoomFactor во время move даёт рывки — держим 1.0, масштаб только CSS (--rmrp-scale).
    let z = 1;
    if (mainWindowDragActive) {
        return { ok: true, factor: lastAppliedZoomFactor, skipped: true };
    }
    if (Math.abs(z - lastAppliedZoomFactor) < 0.001) {
        return { ok: true, factor: lastAppliedZoomFactor };
    }
    try {
        win.webContents.setZoomFactor(z);
        lastAppliedZoomFactor = z;
        return { ok: true, factor: z };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// === Размер основного окна (setting.html) ===
// fixed — resize только через «Изменить»+«Сохранить»; floating — всегда resizable, размер сам пишется
ipcMain.handle('get-window-size', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const bounds = win ? win.getBounds() : getMainWindowSize();
    const saved = getSavedMainWindowSize();
    const computed = getWindowSizeForAreaFraction(MAIN_AREA_FRACTION);
    const mode = getWindowSizeMode();
    return {
        width: bounds.width,
        height: bounds.height,
        saved,
        mode,
        computedDefault: clampMainWindowSize(computed.width, computed.height),
        resizing: !!(windowResizeSession && win),
        minWidth: MIN_MAIN_W,
        minHeight: MIN_MAIN_H,
    };
});

ipcMain.handle('set-window-size-mode', (_event, mode) => {
    const next = setWindowSizeMode(mode);
    // Сброс сессии «Изменить размер» при смене режима
    windowResizeSession = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
        applyWindowSizeModeToMainWindow();
        // В floating сразу запомнить текущий размер
        if (next === 'floating') {
            persistMainWindowSizeFromWindow();
        }
    }
    logAction('Настройки', `Режим размера окна: ${next === 'floating' ? 'плавающий' : 'фиксированный'}`);
    return { ok: true, mode: next };
});

ipcMain.handle('begin-window-resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'no_window' };
    }
    // В плавающем режиме resize уже доступен — отдельная сессия не нужна
    if (getWindowSizeMode() === 'floating') {
        const b = mainWindow.getBounds();
        return {
            ok: true,
            width: b.width,
            height: b.height,
            resizing: false,
            mode: 'floating',
            message: 'floating_always_resizable',
        };
    }
    const b = mainWindow.getBounds();
    windowResizeSession = {
        startWidth: b.width,
        startHeight: b.height,
        startX: b.x,
        startY: b.y,
    };
    applyWindowSizeModeToMainWindow();
    return {
        ok: true,
        width: b.width,
        height: b.height,
        resizing: true,
        mode: 'fixed',
    };
});

ipcMain.handle('save-window-size', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'no_window' };
    }
    const b = mainWindow.getBounds();
    const size = saveMainWindowSize(b.width, b.height);
    mainWindow.setSize(size.width, size.height);
    windowResizeSession = null;
    applyWindowSizeModeToMainWindow();
    return { ok: true, ...size, resizing: false, mode: getWindowSizeMode() };
});

ipcMain.handle('cancel-window-resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'no_window' };
    }
    if (windowResizeSession) {
        mainWindow.setBounds({
            x: windowResizeSession.startX,
            y: windowResizeSession.startY,
            width: windowResizeSession.startWidth,
            height: windowResizeSession.startHeight,
        });
    }
    windowResizeSession = null;
    applyWindowSizeModeToMainWindow();
    const b = mainWindow.getBounds();
    return { ok: true, width: b.width, height: b.height, resizing: false, mode: getWindowSizeMode() };
});

ipcMain.handle('reset-window-size', () => {
    store.delete(MAIN_WINDOW_SIZE_KEY);
    const size = getMainWindowSize();
    if (mainWindow && !mainWindow.isDestroyed()) {
        const wasFloating = getWindowSizeMode() === 'floating';
        mainWindow.setResizable(true);
        mainWindow.setSize(size.width, size.height);
        windowResizeSession = null;
        applyWindowSizeModeToMainWindow();
        if (wasFloating) persistMainWindowSizeFromWindow();
    }
    return { ok: true, ...size, resizing: false, mode: getWindowSizeMode() };
});

ipcMain.handle('set-ghost-mode', async (event, enabled) => {
    const want = !!enabled;
    if (want) {
        const status = await fetchHelperPlusStatus();
        if (!status.isHelperPlus) {
            return { success: false, error: 'Требуется подписка Helper+' };
        }
    }
    store.set('rmrp_ghost_mode', want);
    applyGhostModeToWindow(want);
    logAction('Настройки', `Режим «Невидимка» ${want ? 'включён' : 'выключен'}`);
    return { success: true, enabled: want };
});

ipcMain.handle('open-friends-window', async () => {
    if (!(await ensureAuthSession())) {
        return { success: false, error: 'Нет авторизации' };
    }
    openFriendsWindow();
    return { success: true };
});

ipcMain.handle('close-friends-window', () => {
    if (friendsWindow && !friendsWindow.isDestroyed()) friendsWindow.close();
    return { success: true };
});

// === ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (никнейм / статический ID) ===
// Сохранение данных при первичной регистрации (reg.html) и при редактировании (setting.html)
// ipcMain.handle гарантирует, что страница получит ответ ТОЛЬКО после того,
// как данные реально легли на диск (store.set у electron-store синхронный).
ipcMain.handle('save-user-data', async (event, userData) => {
    try {
        if (!userData || typeof userData !== 'object') {
            return { success: false, error: 'Некорректные данные' };
        }

        const nickname = String(userData.nickname || '').trim();
        const staticId = String(userData.staticId || '').trim();

        if (!nickname || !staticId) {
            return { success: false, error: 'Никнейм и статический ID обязательны' };
        }

        const previous = store.get('rmrpUserData') || {};
        const wasRegistered = previous.registered === true;

        // Согласие на телеметрию обязательно при ПЕРВИЧНОЙ регистрации — проверяем не только в UI,
        // но и здесь, на бэкенде, чтобы это нельзя было обойти
        if (!wasRegistered && userData.telemetryConsent !== true) {
            return { success: false, error: 'Необходимо согласие на обработку технической телеметрии' };
        }

        // Секретное слово — только для legacy-потока восстановления (до Telegram-auth).
        // После входа через Telegram оно не требуется.
        const secretWord = typeof userData.secretWord === 'string' ? userData.secretWord.trim() : '';
        const hasTelegramAuth = !!(await ensureAuthSession());
        if (!wasRegistered && !hasTelegramAuth && !secretWord) {
            return { success: false, error: 'Секретное слово обязательно — оно понадобится для восстановления доступа' };
        }

        const merged = {
            ...previous,
            ...userData,
            nickname,
            staticId,
            // registered только если полный профиль (ник + статик + тег).
            // Иначе новый Telegram-аккаунт мог «зарегистрироваться» без onboard (ТЗ №4 п.1).
            // При редактировании профиля (setting.html), где поле согласия обычно не передаётся,
            // сохраняем ранее выбранное значение, а не сбрасываем его молча
            telemetryConsent: typeof userData.telemetryConsent === 'boolean'
                ? userData.telemetryConsent
                : previous.telemetryConsent === true,
            // Аналогично секретному слову — если оно не передано (например, при редактировании
            // профиля из настроек, где такого поля нет), сохраняем прежнее значение
            secretWord: secretWord || previous.secretWord || '',
            updatedAt: new Date().toISOString()
        };
        merged.userTag = String(merged.userTag || previous.userTag || '').trim();
        merged.registered = isProfileComplete(merged);
        if (merged.registered && !previous.registeredAt) {
            merged.registeredAt = new Date().toISOString();
        }

        // Telegram-пользователь без завершённого onboard не должен «пройти» через save-user-data
        if (hasTelegramAuth && !merged.registered) {
            return {
                success: false,
                error: 'Сначала завершите регистрацию профиля (тег и секретное слово)',
            };
        }

        store.set('rmrpUserData', merged);

        // Подстраховка: сразу же читаем обратно то, что записали,
        // чтобы быть на 100% уверенными, что запись реально прошла.
        const verify = store.get('rmrpUserData');
        const written = verify && verify.nickname === nickname && verify.staticId === staticId;

        if (!written) {
            return { success: false, error: 'Не удалось подтвердить запись на диск' };
        }

        const serverResult = await pushServerProfile({ nickname, static_id: staticId });
        if (!serverResult.success) {
            return { success: false, error: serverResult.error || 'Не удалось сохранить на сервере' };
        }
        scheduleSyncPush();

        if (!wasRegistered && mainWindow) {
            // Кодовое слово никогда не уходит в телеметрию — только факт регистрации.
            sendTelemetryEvent('registration_completed', { registered: true });
            logAction('Профиль', 'Данные профиля сохранены', { nickname, staticId });
            resolveStartPage().then((page) => loadAppPage(mainWindow, page));
        } else if (wasRegistered) {
            logAction('Профиль', 'Данные профиля обновлены', { nickname, staticId });
        }

        return { success: true, data: verify };
    } catch (error) {
        console.error('Ошибка сохранения профиля пользователя:', error);
        return { success: false, error: error.message };
    }
});

// Отдаем текущие данные профиля на страницу настроек
ipcMain.handle('get-user-data', () => {
    return store.get('rmrpUserData') || null;
});

ipcMain.handle('get-profile-local-stats', () => {
    const binds = (store.get('rmrp_binds') || []).length;
    const timers = (store.get('rmrp_timers') || []).length;
    const streakInfo = recomputeAndStoreStreak();
    const pageViews = store.get('rmrp_page_views') || {};
    return {
        binds,
        timers,
        onlineMinutes: streakInfo.todayMinutes || 0,
        streakDays: streakInfo.currentStreak || 0,
        streakMinMinutes: STREAK_MIN_MINUTES,
        pageViews,
    };
});

// Сброс локального прогресса (заметки/онлайн/настройки), никнейм и ID не трогаем
ipcMain.handle('reset-app-data', () => {
    store.delete('rmrp_online_history');
    store.delete('rmrp_streak_data');
    logAction('Настройки', 'Пользователь сбросил локальный прогресс (статистику онлайна и серию)');
    return { success: true };
});

// === СОГЛАСИЕ НА ОБРАБОТКУ ТЕЛЕМЕТРИИ (управляется из setting.html) ===
// Отдаём install ID устройства на страницу настроек (для модалки "Восстановить доступ" —
// пользователь показывает этот ID в Telegram-боте, чтобы подтвердить, какое устройство он восстанавливает)
ipcMain.handle('get-install-id', () => {
    return getOrCreateInstallId();
});

ipcMain.handle('get-telemetry-consent', () => {
    return getTelemetryConsent();
});

// Восстановление доступа по коду (setting.html, кнопка "Восстановить доступ").
// Код пользователь получает по ссылке/у @rmrphelper_bot. Если код верный — бэкенд возвращает
// сохранённые данные аккаунта (профиль, историю онлайна, серию дней), и мы восстанавливаем их
// локально, после чего переключаем окно на main.html.
ipcMain.handle('restore-account', async (event, code) => {
    const trimmedCode = String(code || '').trim();
    if (!trimmedCode) {
        return { success: false, error: 'Введите код восстановления' };
    }

    const installId = getOrCreateInstallId();
    const response = await requestAccountRestore(installId, trimmedCode);

    if (!response || !response.success) {
        logAction('Восстановление доступа', 'Неудачная попытка восстановления по коду');
        return { success: false, error: (response && response.error) || 'Неверный код восстановления' };
    }

    const restored = response.data || {};

    try {
        // Профиль: восстанавливаем никнейм/статический ID/секретное слово, но сохраняем
        // текущее согласие на телеметрию как есть — восстановление доступа не должно молча
        // включать телеметрию, если пользователь её ранее отключил.
        const previous = store.get('rmrpUserData') || {};
        const mergedProfile = {
            ...previous,
            nickname: restored.nickname || previous.nickname || '',
            staticId: restored.staticId || previous.staticId || '',
            secretWord: restored.secretWord || previous.secretWord || '',
            registered: true,
            registeredAt: previous.registeredAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        store.set('rmrpUserData', mergedProfile);

        // История онлайна и серия дней — только если бэкенд их прислал
        if (restored.onlineHistory && typeof restored.onlineHistory === 'object') {
            store.set('rmrp_online_history', restored.onlineHistory);
        }
        if (restored.streakData && typeof restored.streakData === 'object') {
            store.set('rmrp_streak_data', restored.streakData);
        }

        logAction('Восстановление доступа', 'Доступ и данные успешно восстановлены по коду');

        if (mainWindow) {
            resolveStartPage().then((page) => loadAppPage(mainWindow, page));
        }

        return { success: true };
    } catch (err) {
        console.error('Ошибка применения восстановленных данных:', err);
        return { success: false, error: 'Код принят сервером, но не удалось сохранить данные локально' };
    }
});

// Отзыв согласия немедленно блокирует функционал приложения; включение обратно — сразу его открывает.
// Проверка статуса происходит и при каждом следующем запуске (см. resolveStartPage()).
ipcMain.handle('set-telemetry-consent', async (event, value) => {
    const newValue = setTelemetryConsent(value === true);
    logAction('Телеметрия', `Согласие на телеметрию ${newValue ? 'дано' : 'отозвано'}`);

    if (mainWindow) {
        if (!newValue) {
            loadAppPage(mainWindow, 'locked');
        } else {
            sendTelemetryEvent('consent_restored', {});
            const page = await resolveStartPage();
            loadAppPage(mainWindow, page);
        }
    }

    return { success: true, consent: newValue };
});

// Учёт частоты посещения вкладок (обезличенно — просто имя страницы и счётчик)
ipcMain.on('track-page-view', (event, pageName) => {
    if (!pageName || typeof pageName !== 'string') return;
    const stats = store.get('rmrp_page_views') || {};
    stats[pageName] = (stats[pageName] || 0) + 1;
    store.set('rmrp_page_views', stats);
    logAction('Навигация', 'Открыта страница', { page: pageName });
    sendTelemetryEvent('page_view', { page: pageName });
});


// === ОБРАБОТЧИК ДЛЯ ЗАКОНОДАТЕЛЬСТВА (ТОЛЬКО ОПЕРАТИВНАЯ ПАМЯТЬ, БЕЗ ДИСКА) ===
// Вся база кодексов уже предзагружена с GitHub во время splash.html (см. preloadLawsFromGithub).
// legit.html просто забирает готовый объект — никакого сетевого запроса и никакого чтения/записи
// на диск здесь больше нет.
ipcMain.handle('get-laws-cache', async () => {
    return lawsCache;
});

ipcMain.handle('get-trainer-stats', async () => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch('/users/me/trainer');
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('report-trainer-session', async (event, payload) => {
    if (!(await ensureAuthSession())) return { success: false, error: 'Нет авторизации' };
    try {
        return await authApiFetch('/users/me/trainer/session', {
            method: 'POST',
            body: JSON.stringify(payload || {}),
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
});


// === ВЗАИМОДЕЙСТВИЕ ДЛЯ ЗАКРЕПЛЕНИЯ ЗАМЕТОК ===
ipcMain.handle('pin-note', async (event, note) => {
    const title = (note && note.title) || 'Заметка';
    const tag = (note && note.tag) || '';
    const body = (note && note.body) || 'Пусто';
    // Стабильный ключ: одинаковый заголовок+тег → переоткрытие, а не дубль
    const pinKey = `${String(title).slice(0, 80)}::${String(tag).slice(0, 40)}`;

    console.log(`📌 [Main Процесс]: Получен запрос на закрепление заметки: "${title}"`);
    logAction('Заметки', 'Заметка закреплена на рабочем столе', { title, tag });

    if (pinnedNoteWindows.has(pinKey)) {
        const oldWindow = pinnedNoteWindows.get(pinKey);
        if (oldWindow && !oldWindow.isDestroyed()) oldWindow.close();
        pinnedNoteWindows.delete(pinKey);
    }

    // Не transparent: на Windows frameless+transparent ломает resize и иногда drag.
    // Preload обязателен — иначе closeCurrentWindow / window.electron недоступны.
    const widgetWindow = new BrowserWindow({
        width: 320,
        height: 380,
        minWidth: 220,
        minHeight: 160,
        frame: false,
        transparent: false,
        backgroundColor: '#161616',
        alwaysOnTop: true,
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: false,
        hasShadow: true,
        thickFrame: true,
        show: false,
        icon: getWindowIcon(),
        webPreferences: baseWebPreferences(),
    });
    applyWindowIcon(widgetWindow);

    const payload = encodeURIComponent(JSON.stringify({
        title,
        tag,
        body,
    }));

    const failHandler = () => {
        if (!widgetWindow.isDestroyed()) widgetWindow.close();
    };
    widgetWindow.webContents.once('did-fail-load', failHandler);
    widgetWindow.webContents.once('did-finish-load', () => {
        widgetWindow.webContents.removeListener('did-fail-load', failHandler);
    });

    attachExternalLinkHandler(widgetWindow);
    widgetWindow.loadURL(`${SERVER_URL}/sticky#${payload}`);

    widgetWindow.once('ready-to-show', () => {
        if (!widgetWindow.isDestroyed()) {
            widgetWindow.show();
            widgetWindow.focus();
        }
    });

    pinnedNoteWindows.set(pinKey, widgetWindow);

    widgetWindow.on('closed', () => {
        pinnedNoteWindows.delete(pinKey);
    });

    return { success: true, status: 'pinned' };
});


// === ЗАКРЫТИЕ МАЛЕНЬКОГО ОКНА-СТИКЕРА (крестик в sticky.html) ===
ipcMain.on('close-current-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    logAction('Заметки', 'Виджет закреплённой заметки закрыт');
});

// Sticky: поверх всех / не поверх (кнопка в sticky.html)
ipcMain.handle('sticky-set-always-on-top', (event, flag) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { success: false };
    win.setAlwaysOnTop(!!flag);
    return { success: true, alwaysOnTop: !!flag };
});

// === Кастомный CSS-оверлей: Скрыть / Закрыть ===
ipcMain.handle('window-hide', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
        win.hide();
        logAction('Окно', 'Скрыто через оверлей');
        return { success: true };
    }
    // Fallback to main
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        return { success: true };
    }
    return { success: false };
});

ipcMain.handle('window-quit', () => {
    logAction('Окно', 'Выход через оверлей');
    persistMainWindowSizeFromWindow();
    app.quit();
    return { success: true };
});

// === СТАТУС ИГРОВОГО СЕРВЕРА (боссбар в main.html) ===
// TODO: сюда нужно подставить реальный запрос к API вашего RAGE:MP сервера (ip:port из мастер-листа
// CDN, либо собственный статус-эндпоинт) и вернуть { players, maxplayers }. Пока что возвращаем null —
// main.html в этом случае корректно покажет блок "Сервер недоступен", а не будет падать в консоль.
ipcMain.handle('get-server-online', async () => {
    return null;
});

// === СИСТЕМНЫЕ СОБЫТИЯ ЖИЗНЕННОГО ЦИКЛА ===
app.on('window-all-closed', () => {
    logAction('Система', 'Все окна закрыты, приложение завершает работу');
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    persistMainWindowSizeFromWindow();
    if (windowSizeSaveTimer) {
        clearTimeout(windowSizeSaveTimer);
        windowSizeSaveTimer = null;
    }
    globalShortcut.unregisterAll();
    if (syncPushTimer) {
        clearTimeout(syncPushTimer);
        syncPushTimer = null;
    }
    pushLocalSync();
});

// === СБОР КРЭШ-ЛОГОВ (только тип ошибки и стек, без персональных данных) ===
process.on('uncaughtException', (err) => {
    console.error('💥 [Необработанное исключение]:', err);
    logCrashLocally('uncaughtException', err && err.message, err && err.stack);
});
app.on('render-process-gone', (event, webContents, details) => {
    console.error('💥 [Renderer процесс упал]:', details.reason);
    logCrashLocally('render-process-gone', details.reason, JSON.stringify(details));
    const crashedRoute = activePageRoute || 'main';
    const crashedWc = activePageView?.webContents;
    if (mainWindow && !mainWindow.isDestroyed() && crashedWc && webContents === crashedWc) {
        const route = crashedRoute;
        setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            pageViewCache.delete(route);
            activePageView = null;
            activePageRoute = null;
            switchMainAppPage(route).catch(() => loadAppPage(mainWindow, 'main'));
        }, 500);
    }
});

app.whenReady().then(async () => {
    initLogFile();
    migrateLegacyHotkeys();
    try {
        const { session } = require('electron');
        // Security: deny media/mic/camera; only clipboard write allowed
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            if (permission === 'clipboard-sanitized-write') {
                callback(true);
                return;
            }
            callback(false);
        });
        session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
            if (permission === 'clipboard-sanitized-write') return true;
            return false;
        });
        try {
            session.defaultSession.setDevicePermissionHandler(() => false);
        } catch {
            /* старые версии Electron без setDevicePermissionHandler */
        }
    } catch (err) {
        console.warn('⚠️ Не удалось очистить кэш сессии:', err.message);
    }
    recordAppLaunch();
    createSplashWindow();
    createTray();
});

function createTray() {
    if (getGhostModeState().enabled) return;
    if (!fs.existsSync(getTrayIconPath()) && !fs.existsSync(getAppIconPath())) return;
    if (tray) return;

    const trayImage = getTrayIconImage();
    if (!trayImage) return;
    tray = new Tray(trayImage);
    tray.setToolTip('RMRP Helper');
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Показать / Скрыть (F3)', click: () => {
            if (mainWindow.isVisible()) mainWindow.hide();
            else mainWindow.show();
        }},
        { type: 'separator' },
        { label: 'Выход', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
}