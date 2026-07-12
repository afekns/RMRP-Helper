/**
 * Биндер: надёжная вставка текста + переменные + цепочка отыгровок.
 * Windows: SendInput через binder-send.ps1 (STA, Unicode fallback, ожидание отпускания хоткея).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BINDER_VARIABLES_META = [
    { key: 'FirstName', label: 'Имя', example: 'Иван' },
    { key: 'LastName', label: 'Фамилия', example: 'Петров' },
    { key: 'Nickname', label: 'RP-ник', example: 'John_Doe' },
    { key: 'StaticId', label: 'Статик', example: '12345' },
    { key: 'UserTag', label: 'Тег', example: '@mytag' },
    { key: 'realtime', label: 'Локальное время', example: '14:32:05' },
    { key: 'MSKtime', label: 'Московское время', example: '14:32:05' },
    { key: 'Date', label: 'Дата', example: '10.07.2026' },
    { key: 'DateTime', label: 'Дата и время', example: '10.07.2026 14:32' },
    { key: 'Random', label: 'Случайное 1–100', example: '42' },
];

const BINDER_SCRIPT_PATH = path.join(__dirname, 'binder-send.ps1');
const PRE_FOCUS_DELAY_MS = 420;
const BETWEEN_RETRIES_MS = 320;

let binderExecLock = false;
let cachedSocialProfile = null;
let cachedSocialAt = 0;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalTime(date = new Date()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatMoscowTime(date = new Date()) {
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Moscow',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(date).replace(/\./g, ':');
    } catch {
        const msk = new Date(date.getTime() + 3 * 60 * 60 * 1000);
        return formatLocalTime(msk);
    }
}

function formatLocalDate(date = new Date()) {
    return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function formatLocalDateTime(date = new Date()) {
    return `${formatLocalDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function splitDisplayName(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return {
        first: parts[0] || '',
        last: parts.slice(1).join(' '),
    };
}

function buildVariableContext(userData, socialProfile) {
    const user = userData || {};
    const social = socialProfile || {};
    const display = String(social.displayName || social.display_name || user.nickname || '').trim();
    const fromDisplay = splitDisplayName(display);
    const fromNick = splitDisplayName(user.nickname || '');
    const firstName = fromDisplay.first || fromNick.first || user.nickname || 'Игрок';
    const lastName = fromDisplay.last || fromNick.last || '';
    const now = new Date();

    return {
        FirstName: firstName,
        LastName: lastName,
        Nickname: String(user.nickname || '').trim(),
        StaticId: String(user.staticId || '').trim(),
        UserTag: user.userTag ? `@${String(user.userTag).replace(/^@/, '')}` : '',
        realtime: formatLocalTime(now),
        MSKtime: formatMoscowTime(now),
        Date: formatLocalDate(now),
        DateTime: formatLocalDateTime(now),
        Random: String(Math.floor(Math.random() * 100) + 1),
    };
}

function expandBinderVariables(text, ctx) {
    if (!text) return '';
    const map = ctx || {};
    return String(text).replace(/\{([A-Za-z0-9_]+)\}/g, (full, key) => {
        if (Object.prototype.hasOwnProperty.call(map, key)) return String(map[key]);
        const found = Object.keys(map).find((k) => k.toLowerCase() === key.toLowerCase());
        return found ? String(map[found]) : full;
    });
}

function normalizeBindSteps(bind) {
    if (!bind || typeof bind !== 'object') return [];
    if (Array.isArray(bind.steps) && bind.steps.length) {
        return bind.steps
            .map((s) => ({
                text: String(s?.text || s?.macro || '').trim(),
                autoSend: s?.autoSend !== undefined ? !!s.autoSend : !!bind.autoSend,
            }))
            .filter((s) => s.text);
    }
    const legacy = String(bind.macro || '').trim();
    if (!legacy) return [];
    return [{ text: legacy, autoSend: !!bind.autoSend }];
}

function migrateBindRecord(bind) {
    const steps = normalizeBindSteps(bind);
    const macro = steps[0]?.text || String(bind.macro || '').slice(0, 500);
    const stepDelayMs = Math.min(60000, Math.max(0, Number(bind.stepDelayMs) || 1200));
    return {
        ...bind,
        macro,
        steps: steps.map((s) => ({
            text: String(s.text).slice(0, 500),
            autoSend: !!s.autoSend,
        })),
        stepDelayMs,
        openChat: bind.openChat !== false,
    };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function writeTempTextFile(text) {
    const filePath = path.join(os.tmpdir(), `rmrp-bind-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(filePath, String(text), { encoding: 'utf8' });
    return filePath;
}

function runBinderSendScript(textPath, autoSend, openChat, chatVk) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(BINDER_SCRIPT_PATH)) {
            reject(new Error(`binder-send.ps1 не найден: ${BINDER_SCRIPT_PATH}`));
            return;
        }

        const vk = Number.isFinite(chatVk) && chatVk > 0 ? Math.floor(chatVk) : 0x54;

        execFile(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-WindowStyle', 'Hidden',
                '-STA',
                '-ExecutionPolicy', 'Bypass',
                '-File', BINDER_SCRIPT_PATH,
                '-TextPath', textPath,
                '-AutoSend', autoSend ? '1' : '0',
                '-OpenChat', openChat ? '1' : '0',
                '-ChatVk', String(vk),
            ],
            { windowsHide: true, timeout: 120000 },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (!String(stdout || '').includes('OK')) {
                    reject(new Error('binder-send.ps1 завершился без OK'));
                    return;
                }
                resolve();
            },
        );
    });
}

async function typeMacroText(macro, autoSend, logAction, options = {}) {
    if (process.platform !== 'win32') {
        logAction?.('Биндер', 'Автонабор текста поддерживается только на Windows');
        return false;
    }
    if (!macro) return true;

    const openChat = options.openChat !== false;
    const chatVk = Number(options.chatVk) > 0 ? Number(options.chatVk) : 0x54;
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const textPath = writeTempTextFile(macro);
        try {
            if (attempt > 1) {
                await sleep(BETWEEN_RETRIES_MS * attempt);
            }
            await runBinderSendScript(textPath, !!autoSend, openChat, chatVk);
            return true;
        } catch (err) {
            lastError = err;
            logAction?.('Биндер', `Попытка ${attempt}/${maxAttempts} не удалась`, { error: err.message });
            try { fs.unlinkSync(textPath); } catch { /* ignore */ }
        }
    }

    logAction?.('Биндер', 'Все попытки ввода текста исчерпаны', { error: lastError?.message || 'unknown' });
    return false;
}

async function executeBindSequence(bind, options) {
    const {
        logAction,
        getUserData,
        getSocialProfile,
        isHelperPlus,
        prepareGameFocus,
        restoreAppFocus,
        getChatVk,
    } = options;

    if (binderExecLock) {
        logAction?.('Биндер', 'Предыдущий бинд ещё выполняется — пропуск');
        return;
    }
    binderExecLock = true;

    try {
        try {
            await prepareGameFocus?.();
        } catch { /* ignore */ }
        await sleep(PRE_FOCUS_DELAY_MS);

        const chatVk = typeof getChatVk === 'function' ? getChatVk() : 0x54;

        const migrated = migrateBindRecord(bind);
        const steps = migrated.steps;
        if (!steps.length) return;

        const plus = await isHelperPlus();
        let social = cachedSocialProfile;
        const now = Date.now();
        if (!social || now - cachedSocialAt > 120000) {
            social = await getSocialProfile();
            cachedSocialProfile = social;
            cachedSocialAt = now;
        }
        const ctx = buildVariableContext(getUserData(), social);
        const delayMs = Math.min(60000, Math.max(0, Number(migrated.stepDelayMs) || 1200));
        const shouldOpenChat = migrated.openChat !== false;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            let text = step.text;
            if (plus) text = expandBinderVariables(text, ctx);
            const ok = await typeMacroText(text, step.autoSend, logAction, {
                openChat: i === 0 && shouldOpenChat,
                chatVk,
            });
            if (!ok) break;
            if (i < steps.length - 1 && delayMs > 0) {
                await sleep(delayMs);
            }
        }
    } finally {
        binderExecLock = false;
        try {
            await restoreAppFocus?.();
        } catch { /* ignore */ }
    }
}

module.exports = {
    BINDER_VARIABLES_META,
    BINDER_FREE_MAX_STEPS: 3,
    BINDER_PLUS_MAX_STEPS: 12,
    BINDER_FREE_MAX_BINDS: 12,
    expandBinderVariables,
    buildVariableContext,
    normalizeBindSteps,
    migrateBindRecord,
    executeBindSequence,
    typeMacroText,
};