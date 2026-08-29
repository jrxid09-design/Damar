const crypto = require("node:crypto");

const { AITool } = require("../ai/tools");
const binance = require("./binanceService");
const monitor = require("./cryptoMonitorService");
const bot = require("./cryptoBotService");

/**
 * Tool crypto Damar (Binance) — MEMANTAU & MENGEKSEKUSI.
 *
 * Eksekusi order memakai pola DUA-LANGKAH yang wajib:
 *   1. crypto_prepare_order  -> menyiapkan order, TIDAK mengirim apa pun,
 *      mengembalikan rincian + orderId lokal untuk ditinjau pengguna.
 *   2. crypto_confirm_order  -> baru benar-benar mengirim ke Binance,
 *      HANYA setelah pengguna menyetujui secara eksplisit.
 *
 * Ini mencegah eksekusi uang nyata karena salah paham. Model DILARANG
 * memanggil confirm tanpa persetujuan pengguna di pesan sebelumnya.
 */

// Order yang menunggu konfirmasi: id -> { ...detail, expires }.
const pending = new Map();
const TTL_MS = 5 * 60 * 1000;

function reap() {
    const now = Date.now();
    for (const [id, o] of pending) if (o.expires < now) pending.delete(id);
}

// ---- Indikator sederhana (tanpa dependensi) ----------------------
function sma(arr, n) {
    if (arr.length < n) return null;
    return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    const avgG = gain / period, avgL = loss / period;
    if (avgL === 0) return 100;
    const rs = avgG / avgL;
    return 100 - 100 / (1 + rs);
}

function summarizePortfolio(p) {
    const spot = p.spot.slice(0, 12).map(a => `${a.asset}: ${a.total} (≈$${a.valueUsdt})`);
    const fut = p.futures
        ? `Futures: saldo $${p.futures.walletBalance.toFixed(2)}, PnL $${p.futures.unrealizedPnl.toFixed(2)}, ${p.futures.positions.length} posisi`
        : "Futures: —";
    return { totalUsdt: p.totalUsdt, spot, futures: fut, futuresRaw: p.futures };
}

function binanceTools() {

    return [

        // ---- MONITOR -------------------------------------------------

        new AITool({
            name: "crypto_price",
            description:
                "Harga terkini sebuah pasangan crypto di Binance (mis. BTCUSDT, ETHUSDT) " +
                "beserta perubahan 24 jam. Pakai untuk memantau harga.",
            parameters: {
                type: "object",
                properties: {
                    symbol: { type: "string", description: "Pasangan, mis. BTCUSDT. Bila hanya koin (BTC) → +USDT." }
                },
                required: ["symbol"]
            },
            execute: async ({ symbol }) => {
                const raw = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                // "BTC" -> "BTCUSDT"; "ETHBTC" (sudah pasangan) dibiarkan.
                const quotes = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD", "BTC", "ETH", "BNB"];
                const s = quotes.some(q => raw.endsWith(q) && raw.length > q.length) ? raw : `${raw}USDT`;
                const t = await binance.ticker24h(s);
                return { ok: true, ...t };
            }
        }),

        new AITool({
            name: "crypto_portfolio",
            description:
                "Ringkasan portofolio crypto pengguna di Binance: saldo Spot (dikonversi " +
                "ke USDT), saldo & PnL Futures, dan total nilai. Pakai saat pengguna " +
                "menanyakan 'berapa cryptoku', 'nilai portofolio', 'saldo binance'.",
            parameters: { type: "object", properties: {} },
            execute: async () => {
                const p = await binance.portfolio();
                return { ok: true, ...summarizePortfolio(p) };
            }
        }),

        new AITool({
            name: "crypto_positions",
            description:
                "Posisi Futures USDT-M yang sedang terbuka beserta PnL belum-terealisasi, " +
                "harga masuk, dan leverage. Pakai untuk memantau posisi trading aktif.",
            parameters: { type: "object", properties: {} },
            execute: async () => {
                const f = await binance.futuresAccount();
                return { ok: true, walletBalance: f.walletBalance, unrealizedPnl: f.unrealizedPnl, positions: f.positions };
            }
        }),

        // ---- SMART TRADING: analisis + sinyal ------------------------

        new AITool({
            name: "crypto_analyze",
            description:
                "Analisis teknikal cepat sebuah pasangan crypto (RSI, SMA20/50, tren) " +
                "dan beri SINYAL (beli/jual/tahan) beserta alasannya. Data publik — tak " +
                "butuh API key. Pakai untuk 'analisa BTC', 'sinyal ETH', 'layak beli SOL?'. " +
                "Ini bantuan analisa, BUKAN nasihat keuangan; keputusan tetap di pengguna.",
            parameters: {
                type: "object",
                properties: {
                    symbol: { type: "string", description: "Pasangan/koin, mis. BTCUSDT atau BTC." },
                    interval: { type: "string", description: "Timeframe kline: 15m,1h,4h,1d (default 1h)." }
                },
                required: ["symbol"]
            },
            execute: async ({ symbol, interval = "1h" }) => {
                const raw = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                const quotes = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD", "BTC", "ETH", "BNB"];
                const s = quotes.some(q => raw.endsWith(q) && raw.length > q.length) ? raw : `${raw}USDT`;

                const kl = await binance.pub("spot", "/api/v3/klines", { symbol: s, interval, limit: 100 });
                const closes = (Array.isArray(kl) ? kl : []).map(k => Number(k[4])).filter(Number.isFinite);
                if (closes.length < 50) return { ok: false, error: `Data tak cukup untuk ${s}.` };

                const price = closes[closes.length - 1];
                const s20 = sma(closes, 20), s50 = sma(closes, 50);
                const r = rsi(closes, 14);

                const bull = price > s20 && s20 > s50;
                const bear = price < s20 && s20 < s50;
                let signal = "TAHAN", why = [];
                if (r != null && r < 30) { signal = "BELI"; why.push(`RSI ${r.toFixed(0)} (oversold)`); }
                else if (r != null && r > 70) { signal = "JUAL"; why.push(`RSI ${r.toFixed(0)} (overbought)`); }
                if (bull) { why.push("tren naik (harga>SMA20>SMA50)"); if (signal === "TAHAN") signal = "BELI"; }
                if (bear) { why.push("tren turun (harga<SMA20<SMA50)"); if (signal === "TAHAN") signal = "JUAL"; }

                return {
                    ok: true, symbol: s, interval, price,
                    rsi14: r != null ? Number(r.toFixed(1)) : null,
                    sma20: Number(s20.toFixed(4)), sma50: Number(s50.toFixed(4)),
                    tren: bull ? "naik" : bear ? "turun" : "sideways",
                    signal, alasan: why.join(", ") || "netral",
                    catatan: "Analisa teknikal, bukan nasihat keuangan."
                };
            }
        }),

        // ---- EKSEKUSI: LANGKAH 1 — SIAPKAN (tidak mengirim) ----------

        new AITool({
            name: "crypto_prepare_order",
            description:
                "SIAPKAN order beli/jual crypto untuk DITINJAU — TIDAK mengirim apa pun ke " +
                "Binance. Mengembalikan rincian order + orderId lokal. Setelah ini, WAJIB " +
                "tunjukkan rinciannya ke pengguna dan TANYA persetujuan; baru bila pengguna " +
                "SETUJU, panggil crypto_confirm_order dengan orderId itu. JANGAN pernah " +
                "melewati langkah persetujuan pengguna.",
            parameters: {
                type: "object",
                properties: {
                    market: { type: "string", description: "'spot' atau 'futures'." },
                    symbol: { type: "string", description: "Pasangan, mis. BTCUSDT." },
                    side: { type: "string", description: "'BUY' atau 'SELL'." },
                    type: { type: "string", description: "'MARKET' (default) atau 'LIMIT'." },
                    quantity: { type: "number", description: "Jumlah base asset (mis. 0.001 BTC). Untuk futures wajib." },
                    quoteOrderQty: { type: "number", description: "SPOT MARKET saja: belanja sejumlah quote (mis. 50 USDT)." },
                    price: { type: "number", description: "Wajib untuk LIMIT: harga per unit." },
                    reduceOnly: { type: "boolean", description: "Futures: tutup posisi saja (opsional)." }
                },
                required: ["market", "symbol", "side"]
            },
            execute: async ({ market, symbol, side, type = "MARKET", quantity, quoteOrderQty, price, reduceOnly }) => {
                reap();
                if (!binance.configured) {
                    return { ok: false, error: "Binance belum dikonfigurasi. Isi API key + secret di Settings dulu." };
                }
                const m = String(market).toLowerCase() === "futures" ? "futures" : "spot";
                const sym = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
                const sd = String(side).toUpperCase();
                const ty = String(type).toUpperCase();

                if (!["BUY", "SELL"].includes(sd)) return { ok: false, error: "side harus BUY atau SELL." };
                if (ty === "LIMIT" && !(price > 0)) return { ok: false, error: "LIMIT butuh price > 0." };
                if (m === "futures" && !(quantity > 0)) return { ok: false, error: "Futures butuh quantity > 0." };
                if (m === "spot" && !(quantity > 0) && !(quoteOrderQty > 0)) {
                    return { ok: false, error: "Spot butuh quantity atau quoteOrderQty." };
                }

                // Harga acuan saat ini untuk perkiraan nilai.
                let ref = null;
                try { ref = (await binance.price(sym)).price; } catch { /* biarkan */ }
                const estUsdt = quoteOrderQty ?? (quantity && (price ?? ref) ? quantity * (price ?? ref) : null);

                const id = `ord_${crypto.randomBytes(4).toString("hex")}`;
                const order = {
                    id, market: m, symbol: sym, side: sd, type: ty,
                    quantity: quantity ?? null, quoteOrderQty: quoteOrderQty ?? null,
                    price: price ?? null, reduceOnly: reduceOnly ?? null,
                    refPrice: ref, estUsdt: estUsdt != null ? Number(estUsdt.toFixed(2)) : null,
                    testnet: binance.testnet,
                    expires: Date.now() + TTL_MS
                };
                pending.set(id, order);

                return {
                    ok: true,
                    status: "MENUNGGU_KONFIRMASI",
                    orderId: id,
                    ringkasan: `${sd} ${quantity ?? quoteOrderQty + " USDT"} ${sym} (${m.toUpperCase()} ${ty})` +
                        (order.estUsdt ? ` ≈ $${order.estUsdt}` : "") + (order.testnet ? " [TESTNET]" : ""),
                    detail: order,
                    instruksi: "Tunjukkan ringkasan ini ke pengguna dan MINTA persetujuan. Hanya bila setuju, panggil crypto_confirm_order dengan orderId ini. Berlaku 5 menit."
                };
            }
        }),

        // ---- EKSEKUSI: LANGKAH 2 — KIRIM (hanya setelah setuju) ------

        new AITool({
            name: "crypto_confirm_order",
            description:
                "KIRIM order yang sudah disiapkan crypto_prepare_order ke Binance (UANG " +
                "NYATA). Panggil HANYA setelah pengguna menyetujui secara eksplisit di " +
                "pesan sebelumnya. Butuh orderId dari prepare.",
            parameters: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "orderId lokal dari crypto_prepare_order." }
                },
                required: ["orderId"]
            },
            execute: async ({ orderId }) => {
                reap();
                const o = pending.get(String(orderId));
                if (!o) return { ok: false, error: "Order tidak ditemukan atau sudah kedaluwarsa (>5 menit). Siapkan ulang." };
                pending.delete(o.id);

                try {
                    const res = o.market === "futures"
                        ? await binance.placeFuturesOrder(o)
                        : await binance.placeSpotOrder(o);
                    return {
                        ok: true, status: "TERKIRIM", market: o.market, symbol: o.symbol, side: o.side,
                        binanceOrderId: res.orderId, executedQty: res.executedQty, status_binance: res.status,
                        fills: res.fills ?? undefined
                    };
                }
                catch (error) {
                    return { ok: false, error: error.message };
                }
            }
        }),

        new AITool({
            name: "crypto_cancel_order",
            description:
                "Batalkan order yang masih MENUNGGU konfirmasi (belum dikirim). Pakai bila " +
                "pengguna menolak/berubah pikiran sebelum konfirmasi.",
            parameters: {
                type: "object",
                properties: { orderId: { type: "string", description: "orderId lokal dari prepare." } },
                required: ["orderId"]
            },
            execute: async ({ orderId }) => {
                const had = pending.delete(String(orderId));
                return { ok: true, cancelled: had };
            }
        }),

        // ---- AUTO-MONITOR (alarm harga) ------------------------------

        new AITool({
            name: "crypto_set_alert",
            description:
                "Pasang alarm harga: Damar memantau di latar dan memberi tahu (popup " +
                "Console + WhatsApp bila aktif) saat harga menembus ambang. Pakai saat " +
                "pengguna minta 'kabari kalau BTC di atas X', 'ingatkan kalau ETH turun ke Y'.",
            parameters: {
                type: "object",
                properties: {
                    symbol: { type: "string", description: "Pasangan/koin, mis. BTCUSDT atau BTC." },
                    condition: { type: "string", description: "'above' (naik ke/di atas) atau 'below' (turun ke/di bawah)." },
                    price: { type: "number", description: "Harga ambang (USDT)." },
                    note: { type: "string", description: "Catatan opsional yang ikut di notifikasi." }
                },
                required: ["symbol", "condition", "price"]
            },
            execute: async ({ symbol, condition, price, note }) => {
                try {
                    const a = monitor.addAlarm({ symbol, condition, price, note });
                    return { ok: true, alarm: a, message: `Alarm dipasang: ${a.symbol} ${a.condition === "above" ? "≥" : "≤"} $${a.price}.` };
                }
                catch (error) { return { ok: false, error: error.message }; }
            }
        }),

        new AITool({
            name: "crypto_alerts",
            description: "Daftar alarm harga crypto yang aktif/terpicu.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ ok: true, alarms: monitor.listAlarms() })
        }),

        new AITool({
            name: "crypto_remove_alert",
            description: "Hapus sebuah alarm harga berdasarkan id-nya.",
            parameters: {
                type: "object",
                properties: { id: { type: "string", description: "id alarm dari crypto_alerts / crypto_set_alert." } },
                required: ["id"]
            },
            execute: async ({ id }) => ({ ok: true, removed: monitor.removeAlarm(id) })
        }),

        // ---- BOT TRADING ---------------------------------------------

        new AITool({
            name: "crypto_bot_create",
            description:
                "Buat bot trading yang memantau satu pasangan di latar dan memberi sinyal " +
                "BELI/JUAL (RSI + tren SMA). Default AMAN: hanya memberi tahu. Bila " +
                "autoExecute=true (uang nyata), bot mengirim SPOT MARKET BUY senilai " +
                "maxQuoteUsdt saat sinyal BELI (butuh API key + biasanya proxy). Sinyal " +
                "JUAL selalu hanya diberitahukan. Konfirmasikan risiko autoExecute ke pengguna.",
            parameters: {
                type: "object",
                properties: {
                    symbol: { type: "string", description: "Pasangan/koin, mis. BTCUSDT atau BTC." },
                    interval: { type: "string", description: "Timeframe candle: 15m,1h,4h,1d (default 1h)." },
                    autoExecute: { type: "boolean", description: "true = auto-beli saat sinyal BELI (default false)." },
                    maxQuoteUsdt: { type: "number", description: "Batas belanja per sinyal (USDT). Wajib bila autoExecute." }
                },
                required: ["symbol"]
            },
            execute: async ({ symbol, interval, autoExecute, maxQuoteUsdt }) => {
                try {
                    const b = bot.createBot({ symbol, interval, autoExecute, maxQuoteUsdt });
                    return { ok: true, bot: b, message: `Bot ${b.symbol} dibuat (${b.autoExecute ? `auto-beli ≤$${b.maxQuoteUsdt}` : "sinyal saja"}).` };
                }
                catch (error) { return { ok: false, error: error.message }; }
            }
        }),

        new AITool({
            name: "crypto_bot_list",
            description: "Daftar bot trading yang aktif beserta sinyal terakhirnya.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ ok: true, bots: bot.listBots() })
        }),

        new AITool({
            name: "crypto_bot_stop",
            description: "Hentikan & hapus sebuah bot trading berdasarkan id-nya.",
            parameters: {
                type: "object",
                properties: { id: { type: "string", description: "id bot dari crypto_bot_list/create." } },
                required: ["id"]
            },
            execute: async ({ id }) => ({ ok: true, removed: bot.removeBot(id) })
        })

    ];

}

module.exports = { binanceTools };
