const {
    app,
    BrowserWindow,
    ipcMain,
    shell,
    screen,
    session,
    Menu,
    dialog
} = require("electron");

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const DEV = process.argv.includes("--dev");

/** Akar repo Aether, dua tingkat di atas apps/console. */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let mainWindow = null;

/** Proses daemon yang dijalankan dari Console (mode lokal). */
let daemonProcess = null;

// ---- Preferensi -------------------------------------------------

const settingsPath = () =>
    path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = {
    daemonUrl: "http://localhost:3000",
    token: "",
    autoConnect: true,
    accent: "aurora",
    pollInterval: 5000
};

function readSettings() {

    try {
        return {
            ...DEFAULT_SETTINGS,
            ...JSON.parse(fs.readFileSync(settingsPath(), "utf8"))
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }

}

function writeSettings(patch) {

    const merged = { ...readSettings(), ...patch };

    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });

    fs.writeFileSync(
        settingsPath(),
        JSON.stringify(merged, null, 2),
        "utf8"
    );

    return merged;

}

// ---- Server renderer (http origin, bukan file://) ---------------
//
// Renderer disajikan lewat http://127.0.0.1:<port-acak> alih-alih
// dimuat sebagai file://. Sebab: dari file:// origin dokumen bernilai
// null, dan player YouTube menolak sebagian embed dengan cara
// berbeda-beda ("error 153", "This video is unavailable"); sebagian
// API web juga rewel soal origin null. Dengan origin http lokal yang
// SAH, seluruh kelas masalah itu hilang sekaligus. Server hanya
// mengikat 127.0.0.1 dan hanya melayani berkas DI DALAM folder
// renderer (anti path-traversal), jadi tak menambah permukaan serang.

const RENDERER_DIR = path.join(__dirname, "renderer");

let rendererOrigin = null;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm"
};

function startRendererServer() {

    return new Promise((resolve) => {

        const server = http.createServer((req, res) => {

            try {

                if (req.method !== "GET" && req.method !== "HEAD") {
                    res.writeHead(405); res.end(); return;
                }

                const url = new URL(req.url, "http://127.0.0.1");
                let pathname = decodeURIComponent(url.pathname);
                if (pathname === "/" || pathname === "") pathname = "/index.html";

                // Anti path-traversal: hasil resolusi WAJIB di dalam
                // RENDERER_DIR. Bila keluar, tolak.
                const filePath = path.join(RENDERER_DIR, pathname);
                if (filePath !== RENDERER_DIR &&
                    !filePath.startsWith(RENDERER_DIR + path.sep)) {
                    res.writeHead(403); res.end(); return;
                }

                fs.readFile(filePath, (err, data) => {
                    if (err) {
                        res.writeHead(404); res.end("Not found"); return;
                    }
                    res.writeHead(200, {
                        "Content-Type":
                            MIME[path.extname(filePath).toLowerCase()] ??
                            "application/octet-stream"
                    });
                    res.end(req.method === "HEAD" ? undefined : data);
                });

            }
            catch {
                res.writeHead(400); res.end();
            }

        });

        // Gagal mengikat → kembalikan null; createWindow jatuh ke loadFile.
        server.on("error", () => resolve(null));

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            rendererOrigin = `http://127.0.0.1:${port}`;
            resolve(rendererOrigin);
        });

    });

}

// ---- Jendela ----------------------------------------------------

function createWindow() {

    // Layar laptop bisa lebih kecil dari ukuran ideal; jangan
    // membuka jendela yang lebih besar dari area kerja.
    const work = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({

        width: Math.min(1400, work.width - 40),
        height: Math.min(900, work.height - 40),
        minWidth: Math.min(1040, work.width),
        minHeight: Math.min(660, work.height),

        // Titlebar digambar sendiri agar menyatu dengan tema gelap.
        frame: false,
        backgroundColor: "#070910",
        show: false,

        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }

    });

    // http origin bila server siap; kalau tidak, jatuh ke file://.
    if (rendererOrigin) {
        mainWindow.loadURL(`${rendererOrigin}/index.html`);
    }
    else {
        mainWindow.loadFile(path.join(RENDERER_DIR, "index.html"));
    }

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();

        if (DEV) {
            mainWindow.webContents.openDevTools({ mode: "detach" });
        }
    });

    // Tautan eksternal dibuka di browser, bukan di dalam Console.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    for (const event of ["maximize", "unmaximize"]) {
        mainWindow.on(event, () => {
            mainWindow.webContents.send(
                "window:state",
                { maximized: mainWindow.isMaximized() }
            );
        });
    }

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

}

// ---- Daemon lokal -----------------------------------------------

function daemonEntry() {

    return path.join(REPO_ROOT, "src", "server.js");

}

/**
 * Cek apakah sudah ada daemon hidup di alamat yang dituju Console.
 *
 * Tanpa ini, menekan "Jalankan" saat daemon lain (mis. dari
 * `npm start`) sudah aktif akan menelurkan proses kedua yang
 * langsung bentrok port — sumber "kadang jalan kadang tidak".
 */
async function probeDaemon() {

    const { daemonUrl } = readSettings();

    const base = String(daemonUrl ?? "http://localhost:3000").replace(/\/+$/, "");

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), 1500);

    try {

        const response = await fetch(`${base}/api/v1/console/stats`, {
            signal: controller.signal
        });

        return response.ok;

    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }

}

async function startDaemon() {

    // Sudah kita jalankan sendiri sebelumnya.
    if (daemonProcess) {
        return { running: true, pid: daemonProcess.pid, alreadyRunning: true };
    }

    // Sudah ada daemon lain (npm start / instance lama) di alamat
    // yang sama — jangan spawn yang kedua, cukup sambungkan.
    if (await probeDaemon()) {
        return { running: true, external: true };
    }

    const entry = daemonEntry();

    if (!fs.existsSync(entry)) {
        throw new Error(`Tidak menemukan daemon di ${entry}`);
    }

    daemonProcess = spawn(process.execPath, [entry], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            // Jalankan sebagai Node biasa, bukan sebagai proses Electron.
            ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    const forward = (channel) => (data) => {
        mainWindow?.webContents.send("daemon:output", {
            channel,
            text: data.toString()
        });
    };

    daemonProcess.stdout.on("data", forward("stdout"));
    daemonProcess.stderr.on("data", forward("stderr"));

    daemonProcess.on("exit", (code) => {
        mainWindow?.webContents.send("daemon:exit", { code });
        daemonProcess = null;
    });

    return { running: true, pid: daemonProcess.pid };

}

function stopDaemon() {

    if (!daemonProcess) {
        return { running: false };
    }

    daemonProcess.kill();

    daemonProcess = null;

    return { running: false };

}

// ---- IPC --------------------------------------------------------

ipcMain.handle("settings:get", () => readSettings());

ipcMain.handle("settings:set", (event, patch) => writeSettings(patch));

ipcMain.handle("window:minimize", () => mainWindow?.minimize());

ipcMain.handle("window:maximize", () => {

    if (!mainWindow) {
        return;
    }

    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    }
    else {
        mainWindow.maximize();
    }

    return mainWindow.isMaximized();

});

ipcMain.handle("window:close", () => mainWindow?.close());

ipcMain.handle("window:is-maximized", () =>
    mainWindow?.isMaximized() ?? false
);

ipcMain.handle("daemon:status", () => ({
    running: Boolean(daemonProcess),
    pid: daemonProcess?.pid ?? null,
    entry: daemonEntry(),
    repoRoot: REPO_ROOT
}));

ipcMain.handle("daemon:start", async () => {

    try {
        return await startDaemon();
    }
    catch (error) {
        return { running: false, error: error.message };
    }

});

ipcMain.handle("daemon:stop", () => stopDaemon());

ipcMain.handle("shell:open", (event, url) => shell.openExternal(url));

/**
 * Buka folder/berkas di pengelola berkas sistem.
 *
 * `openExternal` khusus URL; untuk path lokal ia tidak dapat
 * diandalkan lintas platform. `openPath` membuka foldernya, dan bila
 * yang ditunjuk sebuah berkas, `showItemInFolder` menyorotnya di
 * dalam foldernya — itu yang diharapkan saat baris project diklik.
 */
ipcMain.handle("shell:reveal", async (event, target) => {

    const p = String(target ?? "").trim();

    if (!p) return { ok: false, error: "path kosong" };

    try {

        const stat = await fs.promises.stat(p);

        if (stat.isDirectory()) {
            const error = await shell.openPath(p);
            return error ? { ok: false, error } : { ok: true, kind: "folder" };
        }

        shell.showItemInFolder(p);
        return { ok: true, kind: "berkas" };

    }
    catch (error) {
        return { ok: false, error: error.message };
    }

});

ipcMain.handle("dialog:error", (event, { title, message }) =>
    dialog.showErrorBox(title ?? "Aether Console", message ?? "")
);

ipcMain.handle("dialog:open-file", async (event, options = {}) => {

    const result = await dialog.showOpenDialog(mainWindow, {
        title: options.title ?? "Pilih berkas",
        properties: ["openFile"],
        filters: options.filters ?? [
            { name: "Dokumen", extensions: ["pdf", "docx", "md", "txt", "csv", "json", "html", "htm"] },
            { name: "Semua berkas", extensions: ["*"] }
        ]
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);

});

ipcMain.handle("dialog:open-directory", async () => {

    const result = await dialog.showOpenDialog(mainWindow, {
        title: "Pilih folder",
        properties: ["openDirectory"]
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);

});

// ---- Siklus hidup aplikasi --------------------------------------

app.whenReady().then(async () => {

    // Sajikan renderer lewat http origin sebelum jendela dibuat.
    await startRendererServer();

    // Menu bawaan tidak dipakai karena jendela frameless.
    Menu.setApplicationMenu(null);

    // Tanpa ini Electron menolak getUserMedia → mikrofon & kamera
    // tidak berfungsi. Console adalah aplikasi milik pengguna
    // sendiri, jadi izin media diberikan.
    const media = new Set([
        "media", "audioCapture", "videoCapture", "mediaKeySystem"
    ]);

    session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback) => {
            callback(media.has(permission));
        }
    );

    session.defaultSession.setPermissionCheckHandler(
        (webContents, permission) => media.has(permission)
    );

    // Catatan: penyuntikan Referer/Origin YouTube sebelumnya DIHAPUS.
    // Renderer kini disajikan dari http://127.0.0.1 (origin sah), jadi
    // player YouTube menerima origin lokal yang wajar tanpa perlu
    // memalsukan header — memalsukannya justru bikin Referer tak
    // konsisten dengan Origin dan memicu "This video is unavailable".

    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

});

app.on("window-all-closed", () => {

    if (process.platform !== "darwin") {
        app.quit();
    }

});

// Jangan tinggalkan daemon yatim saat Console ditutup.
app.on("before-quit", () => stopDaemon());
