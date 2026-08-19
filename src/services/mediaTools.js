const { AITool } = require("../ai/tools");

const telemetry = require("./telemetryService");

/**
 * Tool media & aksi nyata Aether.
 *
 * Aether tidak hanya menjawab dengan teks: ia bisa MENAMPILKAN
 * gambar/video/dokumen di layar, MEMBUKA halaman web untuk riset,
 * dan MENGOPERASIKAN perangkat (buka aplikasi, isi form, klik).
 *
 * Tiga kategori:
 *
 *   1. Presentasi â€” dipancarkan sebagai event `aether:present`;
 *      Console yang tersambung menampilkannya di jendela/panel.
 *
 *   2. Browsing â€” ambil halaman web & kembalikan isinya agar Aether
 *      bisa membaca sumber yang valid (bukan mengarang jawaban).
 *
 *   3. Kendali perangkat â€” jembatan ke plugin desktop (cursor,
 *      tombol, buka aplikasi) yang sudah ada.
 */
function mediaTools() {

    return [

        // ---- Presentasi -----------------------------------------

        new AITool({
            name: "show_image",
            description:
                "Tampilkan sebuah gambar/foto ke pengguna di layar Console. " +
                "Pakai saat pengguna meminta 'tunjukkan foto â€¦' atau hasil " +
                "pencarian Immich/kamera perlu diperlihatkan.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL gambar (http/https/data:)." },
                    caption: { type: "string", description: "Keterangan singkat." }
                },
                required: ["url"]
            },
            execute: async ({ url, caption }) => {
                const fs = require("fs");
                let displayUrl = url;
                try {
                    let p = null;
                    if (url.startsWith("file://")) p = decodeURI(url.replace(/^file:\/\/\/?/, ""));
                    else if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith("\\\\")) p = url;
                    if (p) {
                        const buf = fs.readFileSync(p);
                        const ext = (p.split(".").pop() || "").toLowerCase();
                        const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" })[ext] || "image/png";
                        displayUrl = "data:" + mime + ";base64," + buf.toString("base64");
                    }
                } catch (e) {
                    console.error("[aether] show_image: konversi lokal gagal:", String(e).slice(0, 200));
                }
                telemetry.publish("aether:present", {
                    kind: "image", url: displayUrl, caption: caption ?? null
                });
                return { ok: true, shown: "image", url: displayUrl, converted: displayUrl !== url };
            }
        }),

        new AITool({
            name: "show_video",
            description:
                "Tampilkan sebuah video ke pengguna di layar Console. " +
                "Pakai saat pengguna meminta memutar/memperlihatkan video.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL video (http/https)." },
                    caption: { type: "string", description: "Keterangan singkat." }
                },
                required: ["url"]
            },
            execute: async ({ url, caption }) => {
                telemetry.publish("aether:present", {
                    kind: "video", url, caption: caption ?? null
                });
                return { ok: true, shown: "video", url };
            }
        }),

        new AITool({
            name: "show_chart",
            description:
                "Tampilkan CHART harga LIVE (crypto ATAU saham) di jendela popup " +
                "Console (TradingView). Pakai saat pengguna minta 'tampilkan chart BTC', " +
                "'grafik harga ETH', 'chart saham BBCA/AAPL'. Crypto tanpa bursa → Binance; " +
                "saham sertakan bursa (mis. IDX:BBCA, NASDAQ:AAPL).",
            parameters: {
                type: "object",
                properties: {
                    symbol: { type: "string", description: "Simbol: BTCUSDT, ETH, BINANCE:SOLUSDT, IDX:BBCA, NASDAQ:AAPL." },
                    interval: { type: "string", description: "Interval: 1,5,15,60,240,D,W (default 60)." }
                },
                required: ["symbol"]
            },
            execute: async ({ symbol, interval }) => {

                let s = String(symbol || "").trim().toUpperCase();
                // Tanpa bursa → anggap crypto di Binance; koin polos → +USDT.
                if (!s.includes(":")) {
                    const quotes = ["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "BTC", "ETH", "BNB"];
                    const pair = s.replace(/[^A-Z0-9]/g, "");
                    s = "BINANCE:" + (quotes.some(q => pair.endsWith(q) && pair.length > q.length) ? pair : `${pair}USDT`);
                }

                const iv = String(interval || "60").toUpperCase();
                const embedUrl =
                    "https://s.tradingview.com/widgetembed/?" +
                    `symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(iv)}` +
                    "&theme=dark&style=1&locale=id&hideideas=1&hidesidetoolbar=0&withdateranges=1&allow_symbol_change=1";

                telemetry.publish("aether:present", {
                    kind: "chart", symbol: s, interval: iv, embedUrl, title: `Chart ${s}`
                });

                return { ok: true, shown: "chart", symbol: s, interval: iv };
            }
        }),

        new AITool({
            name: "open_document",
            description:
                "Buka dokumen/berkas (PDF, gambar, teks, dll) untuk pengguna " +
                "di jendela baru. Pakai saat pengguna meminta 'buka berkas â€¦'.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Path berkas lokal atau URL." },
                    title: { type: "string", description: "Judul tampilan." }
                },
                required: ["path"]
            },
            execute: async ({ path, title }) => {
                telemetry.publish("aether:present", {
                    kind: "document", url: path, caption: title ?? null
                });
                return { ok: true, shown: "document", path };
            }
        }),

        // ---- Browsing -------------------------------------------

        new AITool({
            name: "open_url",
            description:
                "Buka halaman web di browser pengguna (jendela baru). Pakai " +
                "saat pengguna meminta membuka sebuah situs tertentu.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL lengkap (https://â€¦)." }
                },
                required: ["url"]
            },
            execute: async ({ url }) => {
                telemetry.publish("aether:present", { kind: "url", url });
                return { ok: true, opened: url };
            }
        }),

        new AITool({
            name: "browse",
            description:
                "Baca isi sebuah halaman web (judul + teks utama) untuk riset. " +
                "Pakai untuk mencari & memverifikasi sumber data yang valid " +
                "sebelum menjawab, bukan mengarang.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL halaman yang akan dibaca." }
                },
                required: ["url"]
            },
            execute: async ({ url }) => {

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 20000);

                try {

                    const res = await fetch(String(url), {
                        headers: { "User-Agent": "Aether/1.0 (+research)" },
                        signal: controller.signal,
                        redirect: "follow"
                    });

                    const html = await res.text();

                    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";

                    const text = String(html)
                        .replace(/<script[\s\S]*?<\/script>/gi, " ")
                        .replace(/<style[\s\S]*?<\/style>/gi, " ")
                        .replace(/<!--[\s\S]*?-->/g, " ")
                        .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
                        .replace(/<br\s*\/?>/gi, "\n")
                        .replace(/<[^>]+>/g, " ")
                        .replace(/&nbsp;/g, " ")
                        .replace(/&amp;/g, "&")
                        .replace(/&lt;/g, "<")
                        .replace(/&gt;/g, ">")
                        .replace(/[ \t]+/g, " ")
                        .replace(/\n{3,}/g, "\n\n")
                        .trim();

                    return {
                        ok: true,
                        url: res.url,
                        status: res.status,
                        title,
                        content: text.slice(0, 6000)
                    };

                }
                catch (error) {
                    return {
                        ok: false,
                        url,
                        error: error.name === "AbortError" ? "timeout" : error.message
                    };
                }
                finally {
                    clearTimeout(timer);
                }

            }
        }),

        // ---- Kendali perangkat ----------------------------------

        new AITool({
            name: "open_terminal",
            description:
                "Buka jendela terminal di Console dan (opsional) jalankan " +
                "perintah di dalamnya agar pengguna melihat prosesnya. Pakai " +
                "saat mengeksekusi perintah yang hasilnya perlu terlihat.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Perintah yang dijalankan (opsional)." },
                    title: { type: "string", description: "Judul terminal." }
                }
            },
            execute: async ({ command, title }) => {
                telemetry.publish("aether:present", {
                    kind: "terminal", command: command ?? null, caption: title ?? null
                });
                return { ok: true, opened: "terminal", command: command ?? null };
            }
        }),

        new AITool({
            name: "open_app",
            description:
                "Buka aplikasi di komputer pengguna (browser, editor, dsb) " +
                "secara langsung oleh Aether. Pakai saat pengguna meminta " +
                "'buka aplikasi â€¦'.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nama aplikasi/perintah." },
                    args: { type: "string", description: "Argumen tambahan (opsional)." }
                },
                required: ["name"]
            },
            execute: async ({ name, args }) => {

                const desktop = require("./desktopControlService");

                return desktop.openApp(name, args ?? "");

            }
        }),

        new AITool({
            name: "fill_form",
            description:
                "Isi sebuah kolom/form pada aplikasi yang sedang terbuka, " +
                "langsung oleh Aether. Pakai saat pengguna meminta 'isi form â€¦', " +
                "'ketik â€¦ di kolom â€¦'.",
            parameters: {
                type: "object",
                properties: {
                    field: { type: "string", description: "Nama/label kolom." },
                    value: { type: "string", description: "Nilai yang diketik." }
                },
                required: ["field", "value"]
            },
            execute: async ({ field, value }) => {

                const desktop = require("./desktopControlService");

                return desktop.fillForm(field, value);

            }
        }),

        new AITool({
            name: "desktop_type",
            description:
                "Ketik teks ke jendela yang sedang aktif, langsung oleh Aether. " +
                "Pakai saat pengguna meminta mengetik sesuatu di layar.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Teks yang diketik." }
                },
                required: ["text"]
            },
            execute: async ({ text }) => {

                const desktop = require("./desktopControlService");

                return desktop.typeText(text);

            }
        }),

        new AITool({
            name: "desktop_press",
            description:
                "Tekan tombol/shortcut (ENTER, TAB, CTRL+S, dsb) pada jendela " +
                "yang sedang aktif. Pakai untuk navigasi & perintah keyboard.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string", description: "mis. ENTER, TAB, ^s (Ctrl+S)." }
                },
                required: ["key"]
            },
            execute: async ({ key }) => {

                const desktop = require("./desktopControlService");

                return desktop.pressKey(key);

            }
        }),

        new AITool({
            name: "desktop_mouse_move",
            description:
                "Gerakkan kursor mouse ke koordinat layar (piksel absolut) " +
                "langsung oleh Aether di Windows. Pakai untuk membidik tombol/area " +
                "sebelum mengklik. BUKAN xdotool (itu Linux dan gagal di sini).",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Koordinat X (piksel dari kiri)." },
                    y: { type: "number", description: "Koordinat Y (piksel dari atas)." }
                },
                required: ["x", "y"]
            },
            execute: async ({ x, y }) => {

                const desktop = require("./desktopControlService");

                return desktop.moveMouse(x, y);

            }
        }),

        new AITool({
            name: "desktop_click",
            description:
                "Klik mouse (left/right/middle) di posisi kursor sekarang, atau di " +
                "koordinat (x,y) bila diberikan â€” langsung oleh Aether di Windows. " +
                "Pakai untuk menekan tombol Play, memilih menu, dsb.",
            parameters: {
                type: "object",
                properties: {
                    button: { type: "string", description: "left | right | middle (default left)." },
                    x: { type: "number", description: "Koordinat X opsional (klik di sana)." },
                    y: { type: "number", description: "Koordinat Y opsional." }
                }
            },
            execute: async ({ button, x, y }) => {

                const desktop = require("./desktopControlService");

                return desktop.clickMouse(button ?? "left", x ?? null, y ?? null);

            }
        }),

        new AITool({
            name: "desktop_windows",
            description:
                "Lihat daftar jendela/aplikasi yang sedang terbuka di komputer " +
                "pengguna. Pakai untuk membidik target sebelum mengendalikan.",
            parameters: { type: "object", properties: {} },
            execute: async () => {

                const desktop = require("./desktopControlService");

                const windows = await desktop.listWindows();

                return { count: windows.length, windows };

            }
        })

    ];

}

module.exports = { mediaTools };
