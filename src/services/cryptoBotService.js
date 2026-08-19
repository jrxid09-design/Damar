const crypto = require("node:crypto");
const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");
const binance = require("./binanceService");

/**
 * Bot trading Aether — strategi otomatis di latar.
 *
 * Tiap bot memantau satu pasangan, menghitung sinyal teknikal (RSI +
 * tren SMA), dan bereaksi saat sinyal BERUBAH menjadi BELI/JUAL:
 *   - default AMAN: hanya MEMBERITAHU (popup + WhatsApp), pengguna yang
 *     memutuskan lewat prepare→confirm.
 *   - autoExecute (opt-in, uang nyata): pada sinyal BELI, kirim SPOT
 *     MARKET BUY senilai maxQuoteUsdt (dibatasi). Sinyal JUAL tetap
 *     hanya diberitahukan (menutup posisi butuh info kepemilikan &
 *     keputusan sadar). Butuh API key + (biasanya) proxy.
 *
 * Interval cek default 5 menit (analisa berbasis candle jam-an).
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "crypto-bots.json"),
    { bots: [] }
);

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

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
    const avgL = loss / period;
    if (avgL === 0) return 100;
    return 100 - 100 / (1 + (gain / period) / avgL);
}

function normSymbol(sym) {
    const s = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return s;
    const quotes = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD", "BTC", "ETH", "BNB"];
    return quotes.some(q => s.endsWith(q) && s.length > q.length) ? s : `${s}USDT`;
}

function listBots() { return store.read().bots ?? []; }

function createBot({ symbol, interval = "1h", autoExecute = false, maxQuoteUsdt = 0 }) {
    const s = normSymbol(symbol);
    if (!s) throw new Error("symbol wajib.");
    if (autoExecute && !(Number(maxQuoteUsdt) > 0)) {
        throw new Error("autoExecute butuh maxQuoteUsdt > 0 (batas belanja per sinyal).");
    }
    const bot = {
        id: `bot_${crypto.randomBytes(3).toString("hex")}`,
        symbol: s, interval, autoExecute: Boolean(autoExecute),
        maxQuoteUsdt: Number(maxQuoteUsdt) || 0,
        active: true, lastSignal: null, createdAt: new Date().toISOString()
    };
    const bots = listBots(); bots.push(bot); store.write({ bots });
    return bot;
}

function removeBot(id) {
    const bots = listBots();
    const next = bots.filter(b => b.id !== String(id));
    store.write({ bots: next });
    return next.length !== bots.length;
}

/** Sinyal untuk satu pasangan dari candle publik. */
async function signalFor(symbol, interval) {
    const kl = await binance.pub("spot", "/api/v3/klines", { symbol, interval, limit: 100 });
    const closes = (Array.isArray(kl) ? kl : []).map(k => Number(k[4])).filter(Number.isFinite);
    if (closes.length < 50) return null;
    const price = closes[closes.length - 1];
    const s20 = sma(closes, 20), s50 = sma(closes, 50), r = rsi(closes, 14);
    let sig = "TAHAN";
    if (r != null && r < 30) sig = "BELI";
    else if (r != null && r > 70) sig = "JUAL";
    if (price > s20 && s20 > s50 && sig === "TAHAN") sig = "BELI";
    if (price < s20 && s20 < s50 && sig === "TAHAN") sig = "JUAL";
    return { price, rsi: r, signal: sig };
}

async function announce(text) {
    try { telemetry.publish("aether:present", { kind: "text", title: "Bot Trading", text }); } catch { /* */ }
    try { await require("./notifyService").send(text); } catch { /* */ }
    try { telemetry.info(`[bot] ${text}`); } catch { /* */ }
}

/** Satu putaran: evaluasi semua bot aktif. */
async function tick() {
    const bots = listBots();
    const active = bots.filter(b => b.active);
    if (!active.length) return;

    let changed = false;
    for (const b of active) {
        try {
            const r = await signalFor(b.symbol, b.interval);
            if (!r) continue;

            // Hanya bereaksi saat sinyal BERUBAH ke BELI/JUAL (tak spam).
            if (r.signal === b.lastSignal || r.signal === "TAHAN") {
                if (r.signal !== b.lastSignal) { b.lastSignal = r.signal; changed = true; }
                continue;
            }
            b.lastSignal = r.signal; changed = true;

            let extra = "";
            if (b.autoExecute && r.signal === "BELI" && binance.configured) {
                try {
                    const res = await binance.placeSpotOrder({
                        symbol: b.symbol, side: "BUY", type: "MARKET", quoteOrderQty: b.maxQuoteUsdt
                    });
                    extra = ` → BELI OTOMATIS $${b.maxQuoteUsdt} (order ${res.orderId}).`;
                } catch (e) { extra = ` → auto-beli GAGAL: ${e.message}`; }
            }
            else if (b.autoExecute && r.signal === "JUAL") {
                extra = " (sinyal JUAL — tutup posisi manual bila perlu).";
            }

            await announce(`🤖 ${b.symbol} sinyal ${r.signal} @ $${r.price} (RSI ${r.rsi?.toFixed(0)}).${extra}`);
        }
        catch { /* harga/analisa gagal — coba lagi berikutnya */ }
    }
    if (changed) store.write({ bots });
}

function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
    if (timer.unref) timer.unref();
    try { telemetry.info("[bot] trading bot aktif"); } catch { /* */ }
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { createBot, removeBot, listBots, signalFor, tick, start, stop };
