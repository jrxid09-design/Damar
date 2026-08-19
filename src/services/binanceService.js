const crypto = require("node:crypto");
const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

/**
 * Binance — mata & tangan Aether ke portofolio crypto.
 *
 * MEMANTAU: harga, saldo Spot, posisi Futures (USDT-M) + PnL.
 * MENGEKSEKUSI: order beli/jual Spot & Futures — TAPI selalu lewat
 * pola dua-langkah (prepare -> konfirmasi pengguna -> confirm) yang
 * ditegakkan di binanceTools, bukan di sini. Service ini hanya jalur
 * REST bertanda-tangan; keputusan "kirim atau tidak" ada di atasnya.
 *
 * Auth: HMAC SHA256 atas query string, header X-MBX-APIKEY. Config
 * (apiKey + secret + testnet) via Settings, disimpan lokal (gitignored),
 * secret dimasking. Graceful bila belum diatur.
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "binance.json"),
    { apiKey: null, secret: null, testnet: false, proxyUrl: null }
);

// Host akun/perdagangan (butuh tanda tangan). DIBLOKIR (403) dari
// sebagian wilayah termasuk Indonesia — di sana wajib set proxyUrl.
const HOST = {
    spot:    { live: "https://api.binance.com",  test: "https://testnet.binance.vision" },
    futures: { live: "https://fapi.binance.com", test: "https://testnet.binancefuture.com" }
};

// Host DATA PUBLIK (harga) — data-api.binance.vision tidak geo-blocked,
// jadi pemantauan harga tetap jalan tanpa proxy.
const DATA_HOST = {
    live: "https://data-api.binance.vision",
    test: "https://testnet.binance.vision"
};

/** Dispatcher proxy undici bila proxyUrl diset (untuk lolos geo-block). */
function dispatcherFor(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const { ProxyAgent } = require("undici");
        return new ProxyAgent(String(proxyUrl));
    }
    catch { return undefined; }
}

/**
 * Ubah kegagalan jaringan Binance menjadi pesan yang bisa ditindak.
 *
 * Dua kegagalan nyata di mesin ini muncul sama-sama sebagai
 * "fetch failed" yang tidak berarti apa-apa:
 *   - UNABLE_TO_GET_ISSUER_CERT_LOCALLY → TLS disadap (antivirus/
 *     proxy perusahaan); root CA-nya ada di Windows, bukan di bundel
 *     Node, jadi Node harus dijalankan dengan --use-system-ca.
 *   - HTTP 403 dari api.binance.com → wilayah diblokir (Indonesia);
 *     hanya proxyUrl yang menembusnya. Data harga publik tetap jalan
 *     lewat data-api.binance.vision, jadi hanya akun/order yang mati.
 */
function jelaskan(error) {
    const kode = String(error?.cause?.code ?? error?.code ?? "");
    if (kode.includes("CERT") || kode.includes("SELF_SIGNED")) {
        return new Error(
            "Binance: sambungan TLS disadap (sertifikat tak dikenal Node). " +
            "Jalankan daemon dengan NODE_OPTIONS=--use-system-ca, atau matikan " +
            "pemindaian HTTPS antivirus/proxy."
        );
    }
    if (kode === "ENOTFOUND" || kode === "EAI_AGAIN") {
        return new Error("Binance: DNS gagal (api.binance.com tak terselesaikan) — jaringan/ISP memblokir.");
    }
    if (kode === "ETIMEDOUT" || error?.name === "TimeoutError") {
        return new Error("Binance: waktu habis. Bila di wilayah terblokir, isi proxyUrl di Settings.");
    }
    return error;
}

class BinanceService {

    cfg() { return store.read(); }

    get apiKey()   { return this.cfg().apiKey || process.env.AETHER_BINANCE_KEY || null; }
    get secret()   { return this.cfg().secret || process.env.AETHER_BINANCE_SECRET || null; }
    get testnet()  { return Boolean(this.cfg().testnet); }
    get proxyUrl() { return this.cfg().proxyUrl || process.env.AETHER_BINANCE_PROXY || null; }
    get configured() { return Boolean(this.apiKey && this.secret); }

    base(market) {
        const h = HOST[market] ?? HOST.spot;
        return this.testnet ? h.test : h.live;
    }

    dataBase() {
        return this.testnet ? DATA_HOST.test : DATA_HOST.live;
    }

    setConfig({ apiKey, secret, testnet, proxyUrl } = {}) {
        const c = this.cfg();
        store.write({
            apiKey:   apiKey   === undefined ? c.apiKey : (apiKey || null),
            secret:   secret   === undefined ? c.secret : (secret || null),
            testnet:  testnet  === undefined ? Boolean(c.testnet) : Boolean(testnet),
            proxyUrl: proxyUrl === undefined ? (c.proxyUrl ?? null) : (proxyUrl || null)
        });
        return this.configView();
    }

    mask(k) {
        if (!k) return null;
        const s = String(k);
        return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-4)}`;
    }

    configView() {
        const c = this.cfg();
        return {
            hasKey: Boolean(c.apiKey), keyHint: this.mask(c.apiKey),
            hasSecret: Boolean(c.secret), secretHint: this.mask(c.secret),
            testnet: Boolean(c.testnet), proxyUrl: c.proxyUrl ?? null,
            configured: this.configured
        };
    }

    // ---- REST ----------------------------------------------------

    /**
     * Permintaan PUBLIK (tanpa tanda tangan) — harga, exchangeInfo.
     * Lewat data-api.binance.vision yang TIDAK geo-blocked, jadi
     * pemantauan harga jalan tanpa proxy.
     */
    async pub(market, endpoint, params = {}, { timeout = 12000 } = {}) {
        const qs = new URLSearchParams(params).toString();
        const url = `${this.dataBase()}${endpoint}${qs ? `?${qs}` : ""}`;
        let res;
        try {
            res = await fetch(url, {
                signal: AbortSignal.timeout(timeout),
                dispatcher: dispatcherFor(this.proxyUrl)
            });
        }
        catch (error) { throw jelaskan(error); }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.msg ? `Binance: ${data.msg}` : `Binance HTTP ${res.status}`);
        return data;
    }

    /** Permintaan BERTANDA-TANGAN (butuh apiKey+secret) — saldo, order. */
    async signed(market, endpoint, params = {}, { method = "GET", timeout = 15000 } = {}) {
        if (!this.configured) {
            const e = new Error("Binance belum dikonfigurasi (API key + secret di Settings).");
            e.code = "BINANCE_NOT_CONFIGURED";
            throw e;
        }
        const query = { ...params, timestamp: Date.now(), recvWindow: 10000 };
        const qs = new URLSearchParams(query).toString();
        const signature = crypto.createHmac("sha256", this.secret).update(qs).digest("hex");
        const url = `${this.base(market)}${endpoint}?${qs}&signature=${signature}`;

        let res;
        try {
            res = await fetch(url, {
                method,
                headers: { "X-MBX-APIKEY": this.apiKey },
                signal: AbortSignal.timeout(timeout),
                dispatcher: dispatcherFor(this.proxyUrl)
            });
        }
        catch (error) { throw jelaskan(error); }

        const data = await res.json().catch(() => ({}));

        // 403 di host akun = wilayah diblokir, bukan kunci API salah.
        // Tanpa keterangan ini pengguna terus mengganti API key yang
        // sebenarnya sudah benar.
        if (res.status === 403 && !this.proxyUrl) {
            throw new Error(
                "Binance memblokir wilayah ini (HTTP 403) untuk akun/order. " +
                "Isi proxyUrl di Settings agar saldo & trading bisa jalan; " +
                "pemantauan harga & chart tetap berfungsi tanpa proxy."
            );
        }

        if (!res.ok) throw new Error(data?.msg ? `Binance: ${data.msg} (${data.code ?? res.status})` : `Binance HTTP ${res.status}`);
        return data;
    }

    // ---- MONITOR -------------------------------------------------

    /** Harga terkini satu simbol (mis. BTCUSDT). */
    async price(symbol) {
        const s = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const d = await this.pub("spot", "/api/v3/ticker/price", { symbol: s });
        return { symbol: s, price: Number(d.price) };
    }

    /** Statistik 24 jam (perubahan %, volume) satu simbol. */
    async ticker24h(symbol) {
        const s = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const d = await this.pub("spot", "/api/v3/ticker/24hr", { symbol: s });
        return {
            symbol: s, last: Number(d.lastPrice), changePct: Number(d.priceChangePercent),
            high: Number(d.highPrice), low: Number(d.lowPrice), volume: Number(d.volume)
        };
    }

    /** Saldo Spot (aset dengan jumlah > 0). */
    async spotBalances() {
        const acc = await this.signed("spot", "/api/v3/account");
        return (acc.balances ?? [])
            .map(b => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked), total: Number(b.free) + Number(b.locked) }))
            .filter(b => b.total > 0)
            .sort((a, b) => b.total - a.total);
    }

    /** Akun Futures USDT-M: saldo + posisi terbuka dengan PnL. */
    async futuresAccount() {
        const acc = await this.signed("futures", "/fapi/v2/account");
        const positions = (acc.positions ?? [])
            .map(p => ({
                symbol: p.symbol, amt: Number(p.positionAmt),
                entry: Number(p.entryPrice), pnl: Number(p.unrealizedProfit),
                leverage: Number(p.leverage)
            }))
            .filter(p => p.amt !== 0);
        return {
            walletBalance: Number(acc.totalWalletBalance),
            unrealizedPnl: Number(acc.totalUnrealizedProfit),
            availableBalance: Number(acc.availableBalance),
            positions
        };
    }

    /**
     * Ringkasan portofolio: nilai Spot (dikonversi ke USDT via harga)
     * + saldo & PnL Futures. Hanya aset bernilai, ringkas.
     */
    async portfolio() {
        const out = { spot: [], futures: null, totalUsdt: 0 };

        const balances = await this.spotBalances();
        const prices = await this.pub("spot", "/api/v3/ticker/price");
        const priceMap = new Map((Array.isArray(prices) ? prices : []).map(p => [p.symbol, Number(p.price)]));
        const usdtOf = (asset, qty) => {
            if (asset === "USDT" || asset === "BUSD" || asset === "FDUSD") return qty;
            return priceMap.has(`${asset}USDT`) ? qty * priceMap.get(`${asset}USDT`) : 0;
        };
        for (const b of balances) {
            const val = usdtOf(b.asset, b.total);
            out.spot.push({ asset: b.asset, total: b.total, valueUsdt: Number(val.toFixed(2)) });
            out.totalUsdt += val;
        }

        try {
            const fut = await this.futuresAccount();
            out.futures = fut;
            out.totalUsdt += fut.walletBalance + fut.unrealizedPnl;
        }
        catch { /* futures mungkin tak diaktifkan di akun — abaikan */ }

        out.totalUsdt = Number(out.totalUsdt.toFixed(2));
        out.spot.sort((a, b) => b.valueUsdt - a.valueUsdt);
        return out;
    }

    // ---- EKSEKUSI (dipanggil hanya setelah konfirmasi di tools) --

    /** Kirim order SPOT. type MARKET atau LIMIT. */
    async placeSpotOrder({ symbol, side, type = "MARKET", quantity, quoteOrderQty, price, timeInForce = "GTC" }) {
        const params = { symbol: String(symbol).toUpperCase(), side: String(side).toUpperCase(), type: String(type).toUpperCase() };
        if (quantity != null) params.quantity = quantity;
        if (quoteOrderQty != null) params.quoteOrderQty = quoteOrderQty;
        if (params.type === "LIMIT") { params.price = price; params.timeInForce = timeInForce; }
        return this.signed("spot", "/api/v3/order", params, { method: "POST" });
    }

    /** Kirim order FUTURES USDT-M. */
    async placeFuturesOrder({ symbol, side, type = "MARKET", quantity, price, timeInForce = "GTC", reduceOnly }) {
        const params = { symbol: String(symbol).toUpperCase(), side: String(side).toUpperCase(), type: String(type).toUpperCase(), quantity };
        if (params.type === "LIMIT") { params.price = price; params.timeInForce = timeInForce; }
        if (reduceOnly != null) params.reduceOnly = String(Boolean(reduceOnly));
        return this.signed("futures", "/fapi/v1/order", params, { method: "POST" });
    }
}

module.exports = new BinanceService();
