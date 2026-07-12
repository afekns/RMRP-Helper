// ==================== PRELOAD (защищённый мост между main.js и страницами) ====================
// ВАЖНО: этот файл выполняется в изолированном контексте (contextIsolation: true) и НЕ должен
// требовать/использовать ничего опасного напрямую в страницах. Единственная задача — через
// contextBridge аккуратно "прокинуть" на страницы объект window.electron с набором безопасных
// функций, каждая из которых внутри дергает соответствующий ipcMain.handle/.on в main.js.
//
// ПРЕЖНЯЯ ВЕРСИЯ ЭТОГО ФАЙЛА БЫЛА СЛУЧАЙНО ПЕРЕЗАПИСАНА СОДЕРЖИМЫМ main.js (полный дубликат,
// без единого contextBridge.exposeInMainWorld). Из-за этого window.electron во всех страницах
// был undefined, что и ломало регистрацию, разблокировку телеметрии, хоткеи, автозапуск,
// закрепление заметок и графики онлайна (в online.html необработанное обращение к
// window.electron.onSyncOnlineUI на верхнем уровне скрипта выбрасывало исключение и обрывало
// выполнение всего остального кода страницы, включая DOMContentLoaded).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // === Telegram-авторизация (reg.html, ТЗ п.2.1) ===
    auth: {
        requestLoginTicket: (intent) => ipcRenderer.invoke('auth-request-login-ticket', intent),
        pollLoginTicket: (ticketId, clientVerifier) =>
            ipcRenderer.invoke('auth-poll-login-ticket', ticketId, clientVerifier),
        isLoggedIn: () => ipcRenderer.invoke('auth-is-logged-in'),
        logout: () => ipcRenderer.invoke('auth-logout'),
    },

    // === Профиль пользователя (onboard.html, setting.html) ===
    completeOnboarding: (payload) => ipcRenderer.invoke('complete-onboarding', payload),
    changeUserTag: (userTag) => ipcRenderer.invoke('change-user-tag', userTag),
    checkUserTag: (userTag) => ipcRenderer.invoke('check-user-tag', userTag),
    uploadProfileMedia: (payload) => ipcRenderer.invoke('upload-profile-media', payload),
    pickProfileImage: (kind) => ipcRenderer.invoke('pick-profile-image', kind),
    pickAndUploadProfileMedia: (kind) => ipcRenderer.invoke('pick-and-upload-profile-media', kind),
    setProfileMediaUrl: (payload) => ipcRenderer.invoke('set-profile-media-url', payload),
    retryStartup: () => ipcRenderer.invoke('retry-startup'),
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    getTagChangeInfo: () => ipcRenderer.invoke('get-tag-change-info'),
    navigateToPage: (route) => ipcRenderer.invoke('navigate-to-page', route),
    getMaintenanceStatus: () => ipcRenderer.invoke('get-maintenance-status'),
    getAccountInfo: () => ipcRenderer.invoke('get-account-info'),
    startChangeTelegram: (secretWord) => ipcRenderer.invoke('start-change-telegram', secretWord),
    startChangeSecret: (newSecretWord) => ipcRenderer.invoke('start-change-secret', newSecretWord),
    pollSecurityTicket: (ticketId) => ipcRenderer.invoke('poll-security-ticket', ticketId),
    requestAccountDeletion: (secretWord) =>
        ipcRenderer.invoke('request-account-deletion', secretWord),
    cancelAccountDeletion: () => ipcRenderer.invoke('cancel-account-deletion'),
    getSocialProfile: () => ipcRenderer.invoke('get-social-profile'),
    getPublicProfile: (ref) => ipcRenderer.invoke('get-public-profile', ref),
    getProfileLocalStats: () => ipcRenderer.invoke('get-profile-local-stats'),
    updateSocialProfile: (payload) => ipcRenderer.invoke('update-social-profile', payload),
    getAchievements: () => ipcRenderer.invoke('get-achievements'),
    getFriends: () => ipcRenderer.invoke('get-friends'),
    sendFriendRequest: (userTag) => ipcRenderer.invoke('send-friend-request', userTag),
    acceptFriendRequest: (friendshipId) => ipcRenderer.invoke('accept-friend-request', friendshipId),
    removeFriend: (friendshipId) => ipcRenderer.invoke('remove-friend', friendshipId),
    openFriendsWindow: () => ipcRenderer.invoke('open-friends-window'),
    closeFriendsWindow: () => ipcRenderer.invoke('close-friends-window'),
    getHelperPlusStatus: () => ipcRenderer.invoke('get-helper-plus-status'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    getGhostMode: () => ipcRenderer.invoke('get-ghost-mode'),
    setGhostMode: (enabled) => ipcRenderer.invoke('set-ghost-mode', enabled),
    // Размер основного окна (setting.html — фиксированный / плавающий)
    getWindowSize: () => ipcRenderer.invoke('get-window-size'),
    setWindowSizeMode: (mode) => ipcRenderer.invoke('set-window-size-mode', mode),
    beginWindowResize: () => ipcRenderer.invoke('begin-window-resize'),
    saveWindowSize: () => ipcRenderer.invoke('save-window-size'),
    cancelWindowResize: () => ipcRenderer.invoke('cancel-window-resize'),
    resetWindowSize: () => ipcRenderer.invoke('reset-window-size'),
    // Сигнал drag → main замораживает setZoomFactor (Windows jitter fix)
    beginWindowDrag: () => ipcRenderer.send('window-drag-start'),
    endWindowDrag: () => ipcRenderer.send('window-drag-stop'),
    onDragLock: (callback) => {
        const listener = (_event, locked) => callback(!!locked);
        ipcRenderer.on('rmrp-drag-lock', listener);
        return () => ipcRenderer.removeListener('rmrp-drag-lock', listener);
    },
    // Масштаб UI без CSS zoom (CSS zoom ломает drag)
    setZoomFactor: (factor) => ipcRenderer.invoke('set-zoom-factor', factor),
    // Прозрачность окна
    getWindowOpacity: () => ipcRenderer.invoke('get-window-opacity'),
    setWindowOpacity: (value) => ipcRenderer.invoke('set-window-opacity', value),
    onWindowOpacityChanged: (callback) => {
        const listener = (_event, opacity) => callback(opacity);
        ipcRenderer.on('window-opacity-changed', listener);
        return () => ipcRenderer.removeListener('window-opacity-changed', listener);
    },
    saveUserData: (userData) => ipcRenderer.invoke('save-user-data', userData),
    getUserData: () => ipcRenderer.invoke('get-user-data'),

    // === Install ID устройства (setting.html — модалка "Восстановить доступ") ===
    getInstallId: () => ipcRenderer.invoke('get-install-id'),

    // === Телеметрия / согласие (reg.html, setting.html, locked.html) ===
    getTelemetryConsent: () => ipcRenderer.invoke('get-telemetry-consent'),
    setTelemetryConsent: (value) => ipcRenderer.invoke('set-telemetry-consent', value),
    trackPageView: (pageName) => ipcRenderer.send('track-page-view', pageName),

    // === Сброс локального прогресса (setting.html) ===
    resetProgress: () => ipcRenderer.invoke('reset-app-data'),

    // === Автозапуск при старте системы (setting.html) ===
    getAutostart: () => ipcRenderer.invoke('get-autostart'),
    setAutostart: (value) => ipcRenderer.invoke('set-autostart', value),
    createDesktopShortcut: () => ipcRenderer.invoke('create-desktop-shortcut'),

    // === Настраиваемые горячие клавиши (setting.html) ===
    getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
    // force=true — принудительная перезапись: main.js атомарно отбирает клавишу у прежнего
    // владельца (бинда или другого системного хоткея), см. checkHotkeyConflict в hotkeyValidator.js
    setHotkey: (id, accelerator, force = false) => ipcRenderer.invoke('set-hotkey', id, accelerator, force),

    // === РП отыгровка жетона (setting.html) ===
    // Текст/команда живут в main-процессе, т.к. хоткей rpToken глобальный и печатает их
    // в игру независимо от того, открыта ли страница "Настройки".
    getRpToken: () => ipcRenderer.invoke('get-rp-token'),
    setRpToken: (payload) => ipcRenderer.invoke('set-rp-token', payload),
    // Временное глушение ВСЕХ глобальных хоткеев на время записи новой комбинации
    // (binder.html/setting.html), чтобы уже занятая клавиша не срабатывала параллельно с вводом
    suspendGlobalShortcuts: () => ipcRenderer.invoke('suspend-global-shortcuts'),
    resumeGlobalShortcuts: () => ipcRenderer.invoke('resume-global-shortcuts'),

    // === Восстановление доступа по коду (setting.html) ===
    // Код пользователь получает по ссылке/у Telegram-бота поддержки; main.js проверяет его
    // в базе данных и, если он верный, возвращает и восстанавливает статистику/серию дней/профиль.
    restoreAccount: (code) => ipcRenderer.invoke('restore-account', code),

    // === Стартовый экран загрузки: проверка appdata + целостности файлов с GitHub (splash.html) ===
    // Подписка на прогресс проверки/загрузки. Возвращает функцию отписки.
    onStartupProgress: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('startup-progress', listener);
        return () => ipcRenderer.removeListener('startup-progress', listener);
    },

    // === Онлайн-трекер и графики (online.html) ===
    getOnlineHistory: () => ipcRenderer.invoke('get-online-history'),
    getStreak: () => ipcRenderer.invoke('get-streak'),
    onStreakDayQualified: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('streak-day-qualified', listener);
        return () => ipcRenderer.removeListener('streak-day-qualified', listener);
    },
    // Подписка на событие обновления графиков в реальном времени.
    // Возвращает функцию отписки, чтобы страница могла корректно снять слушатель при необходимости.
    onSyncOnlineUI: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('sync-online-ui', listener);
        return () => ipcRenderer.removeListener('sync-online-ui', listener);
    },

    // === RP-жетон по хоткею Alt+1 (заготовка под будущую доработку) ===
    onTriggerRpToken: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('trigger-rp-token', listener);
        return () => ipcRenderer.removeListener('trigger-rp-token', listener);
    },

    // === Статус игрового сервера (main.html, боссбар) ===
    getServerOnline: () => ipcRenderer.invoke('get-server-online'),

    // === Законодательство: предзагружено с GitHub в память ещё на splash.html (legit.html) ===
    getLawsCache: () => ipcRenderer.invoke('get-laws-cache'),
    getTrainerStats: () => ipcRenderer.invoke('get-trainer-stats'),
    reportTrainerSession: (payload) => ipcRenderer.invoke('report-trainer-session', payload),

    // === Повторная попытка запуска после экрана "Нет соединения" (offline.html) ===
    retryStartup: () => ipcRenderer.invoke('retry-startup'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // === Закреплённые виджеты заметок на рабочем столе (notein.html, sticky.html) ===
    pinNote: (note) => ipcRenderer.invoke('pin-note', note),
    closeCurrentWindow: () => ipcRenderer.send('close-current-window'),
    stickySetAlwaysOnTop: (flag) => ipcRenderer.invoke('sticky-set-always-on-top', flag),
    // Управление основным окном (кастомный CSS-оверлей)
    hideWindow: () => ipcRenderer.invoke('window-hide'),
    quitApp: () => ipcRenderer.invoke('window-quit'),

    // === Звук завершения таймера (setting.html) ===
    // Общая для всех таймеров настройка (сам звук проигрывается в main-процессе — см. main.js,
    // playTimerSound), чтобы он был слышен системно, а не только пока открыта страница.
    getTimerSoundSettings: () => ipcRenderer.invoke('get-timer-sound-settings'),
    setTimerSound: (soundId) => ipcRenderer.invoke('set-timer-sound', soundId),
    previewTimerSound: (soundId) => ipcRenderer.invoke('preview-timer-sound', soundId),

    // === Биндер: макросы по горячим клавишам (binder.html) ===
    // Хранилище живёт в main-процессе (не localStorage), т.к. глобальные хоткеи биндов
    // регистрируются в main.js и должны работать независимо от того, открыта ли эта страница.
    getBinds: () => ipcRenderer.invoke('get-binds'),
    // force=true — принудительная перезапись при конфликте с системным хоткеем (см. save-binds в main.js)
    saveBinds: (binds, force = false) => ipcRenderer.invoke('save-binds', binds, force),
    // Есть ли на этой машине рабочий модуль автонабора текста. Если false —
    // страница может честно предупредить пользователя, что хоткей сработает, но текст не напечатается.
    getBinderCapabilities: () => ipcRenderer.invoke('get-binder-capabilities'),
    previewBindText: (text) => ipcRenderer.invoke('preview-bind-text', text),

    // === Таймеры (time.html) ===
    // Хранилище и отсчёт живут в main-процессе — mainWindow один на всё приложение и просто
    // перезагружает разные .html при переходах по сайдбару, поэтому таймер должен переживать
    // уход пользователя со страницы time.html на любую другую.
    getTimers: () => ipcRenderer.invoke('get-timers'),
    startTimer: (timer) => ipcRenderer.invoke('start-timer', timer),
    pauseTimer: (id) => ipcRenderer.invoke('pause-timer', id),
    resumeTimer: (id) => ipcRenderer.invoke('resume-timer', id),
    cancelTimer: (id) => ipcRenderer.invoke('cancel-timer', id),
    // Запуск уже существующего таймера заново (сброс на полную длительность, статус running)
    restartTimer: (id) => ipcRenderer.invoke('restart-timer', id),
    // Редактирование названия/длительности/звука существующего таймера
    editTimer: (id, payload) => ipcRenderer.invoke('edit-timer', id, payload),
    // Приходит при старте/паузе/возобновлении/завершении ЛЮБОГО таймера — со свежим списком всех
    // таймеров. Возвращает функцию отписки.
    onTimersUpdated: (callback) => {
        const listener = (event, timers) => callback(timers);
        ipcRenderer.on('timers-updated', listener);
        return () => ipcRenderer.removeListener('timers-updated', listener);
    }
});