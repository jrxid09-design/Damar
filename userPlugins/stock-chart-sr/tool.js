// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class StockChartSRTool {

    constructor() {
        this.name = "stockChartSR";
        this.description = "Ambil data harga saham/indeks (default IHSG ^JKSE) lalu hitung level support & resistance (pivot R1-R3/S1-S3) dan gambar chart SVG dengan garis SR, dikonversi ke data URI base64 agar tampil di Console (hindari blank putih).";
        this.parameters = {
                "symbol": {
                        "type": "string",
                        "description": "Simbol Yahoo Finance, default ^JKSE (IHSG)",
                        "required": false
                },
                "period": {
                        "type": "string",
                        "description": "Rentang data, default 1d",
                        "required": false
                },
                "interval": {
                        "type": "string",
                        "description": "Interval candle, default 1h",
                        "required": false
                },
                "data": {
                        "type": "array",
                        "description": "Data harga opsional [{open,high,low,close}] — bila kosong diambil dari Yahoo",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const symbol = args.symbol || "^JKSE";
        const period = args.period || "1d";
        const interval = args.interval || "1h";
        let candles = args.data;
        if (!candles) {
          const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + period + "&interval=" + interval;
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
          const j = await res.json();
          const r = j && j.chart && j.chart.result && j.chart.result[0];
          if (r) {
            const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
            const ts = r.timestamp || [];
            candles = [];
            for (let i = 0; i < ts.length; i++) {
              const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
              if (o == null || h == null || l == null || c == null) continue;
              candles.push({ date: new Date(ts[i] * 1000).toISOString(), open: o, high: h, low: l, close: c });
            }
          }
        }
        if (!candles || candles.length < 2) return { ok: false, error: "data harga tidak cukup" };
        const closes = candles.map(c => c.close);
        const high = Math.max(...candles.map(c => c.high));
        const low = Math.min(...candles.map(c => c.low));
        const close = closes[closes.length - 1];
        const pivot = (high + low + close) / 3;
        const levels = {
          last: close, high, low, pivot,
          r1: 2 * pivot - low, s1: 2 * pivot - high,
          r2: pivot + (high - low), s2: pivot - (high - low),
          r3: high + 2 * (pivot - low), s3: low - 2 * (high - pivot)
        };
        const W = 900, H = 520, padL = 80, padR = 30, padT = 40, padB = 50;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const min = levels.s3, max = levels.r3, range = (max - min) || 1;
        const X = i => padL + (i / (candles.length - 1)) * plotW;
        const Y = v => padT + (1 - (v - min) / range) * plotH;
        const last = candles.slice(-120);
        let line = "", area = "";
        last.forEach((c, i) => { line += (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(c.close).toFixed(1) + " "; });
        area = "M" + X(0).toFixed(1) + "," + Y(last[0].close).toFixed(1) + " ";
        last.forEach((c, i) => { area += "L" + X(i).toFixed(1) + "," + Y(c.close).toFixed(1) + " "; });
        area += "L" + X(last.length - 1).toFixed(1) + "," + (padT + plotH).toFixed(1) + " L" + X(0).toFixed(1) + "," + (padT + plotH).toFixed(1) + " Z";
        const lvList = [
          { k: "r3", label: "R3", color: "#e74c3c" }, { k: "r2", label: "R2", color: "#e67e22" },
          { k: "r1", label: "R1", color: "#f1c40f" }, { k: "pivot", label: "Pivot", color: "#3498db" },
          { k: "s1", label: "S1", color: "#2ecc71" }, { k: "s2", label: "S2", color: "#27ae60" }, { k: "s3", label: "S3", color: "#16a085" }
        ];
        let glines = "";
        lvList.forEach(L => {
          const y = Y(levels[L.k]).toFixed(1);
          glines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${L.color}" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.8"/>
        <text x="${W - padR - 4}" y="${y - 5}" fill="${L.color}" font-size="12" text-anchor="end" font-weight="bold">${L.label} ${levels[L.k].toFixed(0)}</text>`;
        });
        const fmt = v => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">
        <rect width="${W}" height="${H}" fill="#0d1117"/>
        <text x="${W / 2}" y="24" fill="#e6edf3" font-size="16" text-anchor="middle" font-weight="bold">${symbol} — Support &amp; Resistance</text>
        <text x="${padL}" y="24" fill="#7d8590" font-size="12">Last: ${fmt(levels.last)}</text>
        <path d="${area}" fill="rgba(52,152,219,0.12)" stroke="none"/>
        <path d="${line}" fill="none" stroke="#58a6ff" stroke-width="2"/>
        ${glines}
        </svg>`;
        const dataUri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
        return { ok: true, symbol, levels, dataUri, svg };
    }

}

module.exports = [ new StockChartSRTool() ];
