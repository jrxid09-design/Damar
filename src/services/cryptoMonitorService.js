const crypto = require("node:crypto");
const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");
const binance = require("./binanceService");

/**
 * Auto-monitor crypto — Aether mengawasi harga tanpa diminta dan
 * memberi tahu saat ambang tercapai.
 *
 * Alarm disimpan lokal (bertahan restart). Loop memeriksa harga tiap
 * INTERVAL memakai data publik (data-api.binance.vision — tak butuh
 * proxy). Saat kondisi terpenuhi: tandai terpicu (sekali, tak spam),
 * tampilkan popup di Console (aether:present) + kirim notifikasi
 * (WhatsApp bila aktif).
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "crypto-alerts.json"),
    { alarms: [] }
);

const INTERVAL_MS = 60000;
let timer = null;

function normSymbol(sym) {
    const s = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return s;
    // Sudah pasangan bila berakhir quote-asset DAN punya base sebelumnya
    // (lebih panjang dari quote). "BTC" sendiri BUKAN pasangan → +USDT;
    // "ETHBTC" pasangan → biarkan.
    const quotes = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD", "BTC", "ETH", "BNB"];
    const isPair = quotes.some(q => s.endsWith(q) && s.length > q.length);
    return isPair ? s : `${s}USDT`;
}

function listAlarms() {
    return store.read().alarms ?? [];
}

/** Tambah alarm. condition: 'above' | 'below'. */
function addAlarm({ symbol, condition, price, note = null }) {
    const s = normSymbol(symbol);
    const cond = String(condition).toLowerCase() === "below" ? "below" : "above";
    const p = Number(price);
    if (!s) throw new Error("symbol wajib.");
    if (!(p > 0)) throw new Error("price harus > 0.");

    const alarm = {
        id: `al_${crypto.randomBytes(3).toString("hex")}`,
        symbol: s, condition: cond, price: p, note,
        triggered: false, createdAt: new Date().toISOString()
    };
    const alarms = listAlarms();
    alarms.push(alarm);
    store.write({ alarms });
    return alarm;
}

function removeAlarm(id) {
    const alarms = listAlarms();
    const next = alarms.filter(a => a.id !== String(id));
    store.write({ alarms: next });
    return next.length !== alarms.length;
}

async function fire(alarm, price) {
    const arah = alarm.condition === "above" ? "≥" : "≤";
    const teks = `🔔 Alarm crypto: ${alarm.symbol} kini $${price} (${arah} $${alarm.price})` +
        (alarm.note ? ` — ${alarm.note}` : "");

    // Popup di Console (kind text didukung present).
    try { telemetry.publish("aether:present", { kind: "text", title: "Alarm Crypto", text: teks }); }
    catch { /* abaikan */ }

    // Notifikasi lintas kanal (WhatsApp bila aktif).
    try { await require("./notifyService").send(teks); }
    catch { /* abaikan */ }

    try { telemetry.info(`[crypto] ${teks}`); } catch { /* abaikan */ }
}

/** Satu putaran pemeriksaan alarm aktif. */
async function check() {
    const alarms = listAlarms();
    const active = alarms.filter(a => !a.triggered);
    if (!active.length) return;

    let changed = false;
    for (const a of active) {
        try {
            const { price } = await binance.price(a.symbol);
            const hit = a.condition === "above" ? price >= a.price : price <= a.price;
            if (hit) {
                a.triggered = true;
                a.triggeredAt = new Date().toISOString();
                a.triggerPrice = price;
                changed = true;
                await fire(a, price);
            }
        }
        catch { /* harga gagal diambil — coba lagi putaran berikutnya */ }
    }
    if (changed) store.write({ alarms });
}

function start() {
    if (timer) return;
    // Jangan langsung tembak saat boot; beri jeda satu interval.
    timer = setInterval(() => { check().catch(() => {}); }, INTERVAL_MS);
    if (timer.unref) timer.unref();
    try { telemetry.info("[crypto] auto-monitor aktif"); } catch { /* abaikan */ }
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { addAlarm, removeAlarm, listAlarms, check, start, stop };
