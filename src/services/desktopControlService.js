const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const pexec = promisify(execFile);

/**
 * Kendali desktop langsung oleh Damar.
 *
 * Di Windows memakai PowerShell + UI Automation / WScript. Semua
 * aksi best-effort dan dilaporkan jujur: bila target tidak ketemu,
 * errornya disampaikan, bukan dipalsukan berhasil.
 */

const OPTS = { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 };

/** Jalankan skrip PowerShell, kembalikan stdout. */
async function ps(script) {

    const { stdout } = await pexec(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        OPTS
    );

    return String(stdout ?? "").trim();

}

/** Buka aplikasi berdasarkan nama/perintah. */
async function openApp(name, args = "") {

    const target = String(name).trim();
    if (!target) throw new Error("Nama aplikasi kosong.");

    // Start-Process menerima nama, path, atau perintah di PATH.
    const arg = args ? ` -ArgumentList '${args.replace(/'/g, "''")}'` : "";

    await ps(
        `$ErrorActionPreference='Stop'; ` +
        `Start-Process '${target.replace(/'/g, "''")}'${arg}; ` +
        `Write-Output 'ok'`
    );

    return { ok: true, opened: target };

}

/** Ketik teks ke jendela yang sedang fokus. */
async function typeText(text) {

    const value = String(text ?? "");
    if (!value) throw new Error("Teks kosong.");

    // SendWait mengetik ke aplikasi foreground.
    await ps(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('${value.replace(/'/g, "''").replace(/[+^%(){}[\]]/g, "{$&}")}'); ` +
        `Write-Output 'ok'`
    );

    return { ok: true, typed: value.length };

}

/** Tekan tombol/shortcut (mis. ENTER, TAB, ^s). */
async function pressKey(key) {

    const k = String(key ?? "").trim();
    if (!k) throw new Error("Tombol kosong.");

    await ps(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('${k.replace(/'/g, "''")}'); ` +
        `Write-Output 'ok'`
    );

    return { ok: true, pressed: k };

}

/** Isi kolom berlabel pada jendela foreground via UI Automation. */
async function fillForm(field, value) {

    const f = String(field ?? "").replace(/'/g, "''");
    const v = String(value ?? "").replace(/'/g, "''");

    // Cari elemen bertuliskan label, lalu set nilainya. Best-effort:
    // tidak semua kontrol mendukung ValuePattern.
    const script = `
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${f}')
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
        if (-not $el) { Write-Output 'not-found'; exit 0 }
        try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $vp.SetValue('${v}')
            Write-Output 'ok'
        } catch {
            $el.SetFocus()
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.SendKeys]::SendWait('${v.replace(/[+^%(){}[\]]/g, "{$&}")}')
            Write-Output 'typed'
        }
    `;

    const out = await ps(script);

    if (out === "not-found") {
        return { ok: false, error: `Kolom "${field}" tidak ditemukan.` };
    }

    return { ok: true, field, via: out === "ok" ? "uia" : "sendkeys" };

}

/** Daftar jendela yang sedang terbuka (untuk membidik target). */
async function listWindows() {

    const out = await ps(
        `Get-Process | Where-Object { $_.MainWindowTitle } | ` +
        `Select-Object -First 25 ProcessName, MainWindowTitle | ` +
        `ConvertTo-Json -Compress`
    );

    try {
        const arr = JSON.parse(out || "[]");
        return (Array.isArray(arr) ? arr : [arr]).map(p => ({
            app: p.ProcessName, title: p.MainWindowTitle
        }));
    }
    catch {
        return [];
    }

}

/**
 * Pindahkan kursor ke koordinat layar absolut (piksel).
 *
 * Windows-native lewat user32!SetCursorPos — TIDAK memakai xdotool
 * (khusus Linux/X11). xdotool selalu gagal di sini dan itu sumber
 * "Command failed: xdotool mousemove …" sebelumnya.
 */
async function moveMouse(x, y) {

    const px = Math.round(Number(x));
    const py = Math.round(Number(y));
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
        throw new Error("Koordinat mouse tidak valid.");
    }

    await ps(
        `$s='[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);'; ` +
        `$m=Add-Type -MemberDefinition $s -Name Mv -Namespace Win -PassThru; ` +
        `[Win.Mv]::SetCursorPos(${px},${py}) | Out-Null; Write-Output 'ok'`
    );

    return { ok: true, moved: { x: px, y: py } };

}

/**
 * Klik mouse di posisi sekarang, atau di (x,y) bila diberikan.
 * button: left | right | middle. Windows-native (user32!mouse_event).
 */
async function clickMouse(button = "left", x = null, y = null) {

    const btn = String(button ?? "left").toLowerCase();
    // [down, up] flag mouse_event per tombol.
    const codes = ({
        left:   [0x0002, 0x0004],
        right:  [0x0008, 0x0010],
        middle: [0x0020, 0x0040]
    })[btn] ?? [0x0002, 0x0004];

    const move = (x != null && y != null)
        ? `[Win.Mc]::SetCursorPos(${Math.round(Number(x))},${Math.round(Number(y))}) | Out-Null; `
        : "";

    await ps(
        `$s='[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); ` +
        `[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);'; ` +
        `$m=Add-Type -MemberDefinition $s -Name Mc -Namespace Win -PassThru; ` +
        move +
        `[Win.Mc]::mouse_event(${codes[0]},0,0,0,0); [Win.Mc]::mouse_event(${codes[1]},0,0,0,0); Write-Output 'ok'`
    );

    return { ok: true, clicked: btn, at: (x != null && y != null) ? { x: Math.round(Number(x)), y: Math.round(Number(y)) } : "current" };

}

module.exports = { openApp, typeText, pressKey, fillForm, listWindows, moveMouse, clickMouse };
