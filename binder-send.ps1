#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$TextPath,
    [int]$AutoSend = 0,
    [int]$OpenChat = 1,
    [int]$ChatVk = 0x54
)

$ErrorActionPreference = 'Stop'

$typeDef = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class RmrpBinderInput {
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
        public uint padding1;
        public uint padding2;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    static extern ushort MapVirtualKey(ushort uCode, uint uMapType);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    const uint INPUT_KEYBOARD = 1;
    const uint KEYUP = 0x0002;
    const uint UNICODE = 0x0004;
    const uint SCANCODE = 0x0008;
    const int SW_RESTORE = 9;

    static void SendVk(ushort vk, bool keyUp) {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].ki.wVk = vk;
        inp[0].ki.dwFlags = keyUp ? KEYUP : 0u;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void SendScan(ushort scan, bool keyUp) {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].ki.wScan = scan;
        inp[0].ki.dwFlags = SCANCODE | (keyUp ? KEYUP : 0u);
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void TapVk(ushort vk, int holdMs) {
        SendVk(vk, false);
        Thread.Sleep(holdMs);
        SendVk(vk, true);
    }

    static void TapScan(ushort scan, int holdMs) {
        SendScan(scan, false);
        Thread.Sleep(holdMs);
        SendScan(scan, true);
    }

    // Одно нажатие: scancode (игры) или VK (fallback). Нельзя слать оба — чат откроется дважды.
    static void TapKeyRobust(ushort vk, int holdMs) {
        ushort scan = MapVirtualKey(vk, 0);
        if (scan != 0) {
            TapScan(scan, holdMs);
        } else {
            TapVk(vk, holdMs);
        }
    }

    static bool ForceForeground(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return false;
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint targetPid;
        uint targetThread = GetWindowThreadProcessId(hwnd, out targetPid);
        uint curThread = GetCurrentThreadId();
        AttachThreadInput(curThread, fgThread, true);
        AttachThreadInput(curThread, targetThread, true);
        ShowWindow(hwnd, SW_RESTORE);
        bool ok = SetForegroundWindow(hwnd);
        AttachThreadInput(curThread, targetThread, false);
        AttachThreadInput(curThread, fgThread, false);
        return ok;
    }

    static IntPtr FindGameWindow() {
        string[] names = new string[] { "GTA5", "ragemp_v", "altv", "FiveM", "CitizenFX" };
        foreach (string name in names) {
            try {
                foreach (Process p in Process.GetProcessesByName(name)) {
                    IntPtr hwnd = p.MainWindowHandle;
                    if (hwnd != IntPtr.Zero && IsWindowVisible(hwnd)) return hwnd;
                }
            } catch { }
        }

        IntPtr best = IntPtr.Zero;
        uint selfPid = (uint)Process.GetCurrentProcess().Id;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == selfPid || pid == 0) return true;
            try {
                Process p = Process.GetProcessById((int)pid);
                string n = (p.ProcessName ?? "").ToLowerInvariant();
                if (n == "gta5" || n.StartsWith("ragemp") || n == "altv" || n == "fivem" || n.StartsWith("citizenfx")) {
                    best = hWnd;
                    return false;
                }
            } catch { }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static void FocusGameWindow() {
        for (int attempt = 0; attempt < 4; attempt++) {
            IntPtr hwnd = FindGameWindow();
            if (hwnd != IntPtr.Zero) {
                ForceForeground(hwnd);
                Thread.Sleep(120);
                if (GetForegroundWindow() == hwnd) return;
            }
            Thread.Sleep(80);
        }
    }

    public static void WaitModifiersRelease(int maxMs) {
        ushort[] mods = new ushort[] { 0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        int waited = 0;
        while (waited < maxMs) {
            bool any = false;
            foreach (ushort vk in mods) {
                if ((GetAsyncKeyState(vk) & 0x8000) != 0) { any = true; break; }
            }
            if (!any) return;
            Thread.Sleep(16);
            waited += 16;
        }
    }

    public static void OpenChat(ushort chatVk) {
        if (chatVk == 0) chatVk = 0x54;
        WaitModifiersRelease(900);
        Thread.Sleep(80);
        FocusGameWindow();
        Thread.Sleep(160);
        TapKeyRobust(chatVk, 55);
        Thread.Sleep(560);
    }

    public static void PasteFromClipboard() {
        SendVk(0x11, false);
        Thread.Sleep(30);
        TapVk(0x56, 35);
        Thread.Sleep(30);
        SendVk(0x11, true);
        Thread.Sleep(40);
    }

    public static void EnterKey() {
        Thread.Sleep(70);
        TapVk(0x0D, 40);
    }

    public static void TypeUnicode(string text) {
        if (string.IsNullOrEmpty(text)) return;
        foreach (char ch in text) {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.ki.wScan = ch;
            down.ki.dwFlags = UNICODE;
            INPUT up = down;
            up.ki.dwFlags = UNICODE | KEYUP;
            INPUT[] batch = new INPUT[] { down, up };
            SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(7);
        }
    }

    public static void SetClipboardText(string text) {
        Thread.Sleep(50);
        Clipboard.SetText(text ?? string.Empty, TextDataFormat.UnicodeText);
        Thread.Sleep(120);
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'RmrpBinderInput').Type) {
    Add-Type -TypeDefinition $typeDef -ReferencedAssemblies System.Windows.Forms
}

$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.UTF8Encoding]::new($false))
$chatVkU = [uint16][Math]::Max(0, $ChatVk)

try {
    if ($OpenChat -eq 1) {
        [RmrpBinderInput]::OpenChat($chatVkU)
    } else {
        [RmrpBinderInput]::WaitModifiersRelease(900)
        Start-Sleep -Milliseconds 140
    }

    $pasteOk = $false
    try {
        [RmrpBinderInput]::SetClipboardText($text)
        [RmrpBinderInput]::PasteFromClipboard()
        $pasteOk = $true
    } catch {
        $pasteOk = $false
    }

    if (-not $pasteOk) {
        Start-Sleep -Milliseconds 80
        [RmrpBinderInput]::TypeUnicode($text)
    }

    if ($AutoSend -eq 1) {
        [RmrpBinderInput]::EnterKey()
    }

    Write-Output 'OK'
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    Remove-Item -LiteralPath $TextPath -Force -ErrorAction SilentlyContinue
}