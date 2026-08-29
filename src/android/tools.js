const { AITool } = require("../ai/tools");
const adb = require("./adb");

/**
 * Tool kendali Android — Damar mengoperasikan HP pemilik lewat ADB.
 *
 * Butuh HP terhubung (USB-debugging) atau `android_connect` (nirkabel).
 * Aksi ketuk/geser/ketik/shell destruktif → lewat gerbang konfirmasi
 * (riskCatalog), seperti kendali desktop.
 */
function androidTools() {

    return [

        new AITool({
            name: "android_devices",
            description: "DAFTAR perangkat Android yang terhubung (serial, status, model). Panggil dulu bila ragu HP tersambung.",
            parameters: { type: "object", properties: {} },
            execute: async () => adb.devices()
        }),

        new AITool({
            name: "android_connect",
            description: "Hubungkan HP lewat ADB NIRKABEL (adb over TCP). Beri 'ip:port' (mis. 192.168.1.5:5555). HP & PC harus satu jaringan dan debugging nirkabel aktif.",
            parameters: {
                type: "object",
                properties: { address: { type: "string", description: "ip:port perangkat." } },
                required: ["address"]
            },
            execute: async ({ address }) => adb.connect(address)
        }),

        new AITool({
            name: "android_info",
            description: "Info HP: model, versi Android, resolusi & kerapatan layar (untuk menghitung koordinat ketuk).",
            parameters: { type: "object", properties: { serial: { type: "string", description: "Serial perangkat (opsional bila hanya satu)." } } },
            execute: async ({ serial }) => adb.info({ serial })
        }),

        new AITool({
            name: "android_tap",
            description: "KETUK layar di koordinat (x,y) piksel. Pakai android_info untuk tahu resolusi, atau android_screenshot untuk melihat dulu.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number" }, y: { type: "number" },
                    serial: { type: "string", description: "Serial (opsional)." }
                },
                required: ["x", "y"]
            },
            execute: async ({ x, y, serial }) => adb.tap(x, y, { serial })
        }),

        new AITool({
            name: "android_swipe",
            description: "GESER dari (x1,y1) ke (x2,y2) selama durasi ms. Untuk scroll, swipe halaman, buka notifikasi (geser dari atas).",
            parameters: {
                type: "object",
                properties: {
                    x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
                    ms: { type: "number", description: "Durasi ms (default 300)." },
                    serial: { type: "string" }
                },
                required: ["x1", "y1", "x2", "y2"]
            },
            execute: async ({ x1, y1, x2, y2, ms, serial }) => adb.swipe(x1, y1, x2, y2, ms ?? 300, { serial })
        }),

        new AITool({
            name: "android_type",
            description: "KETIK teks ke field yang sedang fokus di HP.",
            parameters: {
                type: "object",
                properties: { text: { type: "string" }, serial: { type: "string" } },
                required: ["text"]
            },
            execute: async ({ text, serial }) => adb.text(text, { serial })
        }),

        new AITool({
            name: "android_key",
            description: "Tekan tombol sistem via keyevent. Contoh keycode: HOME, BACK, ENTER, APP_SWITCH, POWER, VOLUME_UP, VOLUME_DOWN, MENU. (Damar menambah prefix KEYCODE_ otomatis bila perlu.)",
            parameters: {
                type: "object",
                properties: { keycode: { type: "string", description: "mis. HOME / BACK / ENTER / KEYCODE_HOME." }, serial: { type: "string" } },
                required: ["keycode"]
            },
            execute: async ({ keycode, serial }) => {
                const kc = /^KEYCODE_/i.test(keycode) ? keycode.toUpperCase() : "KEYCODE_" + String(keycode).toUpperCase();
                return adb.key(kc, { serial });
            }
        }),

        new AITool({
            name: "android_open_app",
            description: "BUKA aplikasi lewat nama paket (mis. com.whatsapp, com.android.chrome). Pakai android_apps untuk mencari nama paket.",
            parameters: {
                type: "object",
                properties: { package: { type: "string", description: "Nama paket, mis. com.whatsapp." }, serial: { type: "string" } },
                required: ["package"]
            },
            execute: async ({ package: pkg, serial }) => adb.openApp(pkg, { serial })
        }),

        new AITool({
            name: "android_apps",
            description: "Cari aplikasi terpasang (nama paket), opsional filter kata kunci. Untuk menemukan paket sebelum android_open_app.",
            parameters: {
                type: "object",
                properties: { filter: { type: "string", description: "Kata kunci (opsional), mis. 'whats'." }, serial: { type: "string" } }
            },
            execute: async ({ filter, serial }) => adb.listApps(filter, { serial })
        }),

        new AITool({
            name: "android_screenshot",
            description: "TANGKAP layar HP jadi PNG (kembalikan path berkas). Tampilkan dengan show_image bila ingin dilihat pengguna. Pakai sebelum mengetuk agar tahu posisi elemen.",
            parameters: { type: "object", properties: { serial: { type: "string" } } },
            execute: async ({ serial }) => adb.screenshot({ serial })
        }),

        new AITool({
            name: "android_notifications",
            description: "BACA notifikasi aktif di HP (judul/teks). Untuk memantau pesan/pemberitahuan.",
            parameters: { type: "object", properties: { serial: { type: "string" } } },
            execute: async ({ serial }) => adb.notifications({ serial })
        }),

        new AITool({
            name: "android_shell",
            description: "Jalankan perintah shell Android mentah (am/pm/settings/dumpsys/input/dll). Untuk hal yang tak tercakup tool lain. Baca hasilnya apa adanya.",
            parameters: {
                type: "object",
                properties: { command: { type: "string", description: "Perintah shell, mis. 'am start -a android.intent.action.VIEW -d https://x'." }, serial: { type: "string" } },
                required: ["command"]
            },
            execute: async ({ command, serial }) => adb.shell(command, { serial })
        })

    ];

}

module.exports = { androidTools };
