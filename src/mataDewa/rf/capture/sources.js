"use strict";

/**
 * RF capture foundation (Phase B) — SATU batas masuk lokal untuk CSI.
 *
 * SUMBER (trusted composition only — tidak ada penemuan otomatis):
 *  - "replay": file .csi.csv (format esp-csi get-started) atau .ndjson
 *    (satu objek CsiFrame per baris). OFFLINE-SAFE — tidak pernah
 *    menyentuh jaringan.
 *  - "udp": frame biner RuView ADR-018 — HANYA bila trusted composition
 *    secara eksplisit mengizinkan (allowLocalUdp) DAN bind ke loopback.
 *    Default: DITOLAK (AUTHORIZED_LOCAL_SOURCE fail-closed pra-Lane4).
 *
 * HUKUM:
 *  - Semua frame melewati validasi + batas di sini; tidak ada parser
 *    lain di luar modul ini.
 *  - Bounded: jumlah subcarrier, ukuran frame, laju (maxRateHz), ukuran
 *    ring buffer. Pelanggaran → frame DIBUANG dengan penghitung, bukan
 *    buffer tak terbatas.
 *  - MAC address perangkat TIDAK pernah masuk rekaman kanonik — hanya
 *    sensorId yang diberikan trusted composition.
 *  - Tidak ada klaim: modul ini menghasilkan frame mentah terukur;
 *    interpretasi (motion/presence) ada di rf/processing.
 */

const fs = require("node:fs");
const readline = require("node:readline");

// ---- Batas capture --------------------------------------------------------

const CAPTURE_LIMITS = Object.freeze({
    MAX_SUBCARRIERS: 1024,          // ESP32 HT20/HT40 max ~256; 80MHz ~512
    MAX_FRAME_BYTES: 64 * 1024,     // satu frame biner
    MAX_IQ_PAIRS: 1024,
    MAX_CSV_LINE_BYTES: 64 * 1024,
    MAX_FILE_BYTES: 100 * 1024 * 1024,
    MAX_RING_FRAMES: 4096,          // ring buffer frame mentah
    DEFAULT_MAX_RATE_HZ: 50,        // mirror RuView 50 Hz software gate
    MAX_CHANNELS: 16
});

const ADR018_MAGIC = 0xc5110001;    // RuView ADR-018, LE
const ADR018_HEADER_SIZE = 20;

const SOURCE_KIND = Object.freeze({
    REPLAY: "replay",
    UDP: "udp",
    SERIAL: "serial"
});

// ---- Parsers (murni, tanpa I/O) -------------------------------------------

/**
 * Parse satu baris CSV esp-csi → CsiFrame | null.
 *
 * Dua varian header (esp-csi get-started):
 *  - Standar 24 kolom: type,id,mac,rssi,rate,sig_mode,mcs,bandwidth,
 *    smoothing,not_sounding,aggregation,stbc,fec_coding,sgi,noise_floor,
 *    ampdu_cnt,channel,secondary_channel,local_timestamp,ant,sig_len,
 *    rx_state|rx_format,len,first_word,data
 *  - C5/C6 14 kolom: type,id,mac,rssi,rate,noise_floor,fft_gain,agc_gain,
 *    channel,local_timestamp,sig_len,rx_state,len,first_word,data
 *
 * `data` = string JSON array interleaved [imag, real, imag, real, ...]
 * (esp-csi: complex(real=raw[i*2+1], imag=raw[i*2])).
 *
 * Mengembalikan frame AMPLITUD/FASE per subcarrier + metadata terukur.
 * Baris rusak/berlebih → { ok:false, reason } (dibuang, bukan crash).
 */
function parseEspCsiCsvLine(line) {
    if (typeof line !== "string" || !line.trim()) {
        return { ok: false, reason: "baris kosong" };
    }
    if (Buffer.byteLength(line, "utf8") > CAPTURE_LIMITS.MAX_CSV_LINE_BYTES) {
        return { ok: false, reason: "baris melebihi batas" };
    }
    if (!line.startsWith("CSI_DATA,")) {
        return { ok: false, reason: "bukan baris CSI_DATA" };
    }

    // CSV sederhana: hanya field terakhir (data) berkutip. Parse manual.
    const firstQuote = line.indexOf('"');
    if (firstQuote === -1) return { ok: false, reason: "field data tidak ditemukan" };
    const lastQuote = line.lastIndexOf('"');
    if (lastQuote <= firstQuote) return { ok: false, reason: "field data tidak tertutup" };
    const rawHead = line.slice(0, firstQuote).split(",");
    // Buang field kosong di ujung (koma sebelum kutip data).
    while (rawHead.length > 0 && rawHead[rawHead.length - 1].trim() === "") rawHead.pop();
    const head = rawHead.map(s => s.trim());
    const dataJson = line.slice(firstQuote + 1, lastQuote);

    // head[0] = "CSI_DATA", head[1..] = kolom metadata (data dipisah).
    // Dua varian sah (mirror DATA_COLUMNS_NAMES esp-csi):
    //  - Standar 24 kolom (25 incl. data): len=head[22], first_word=head[23]
    //  - C5/C6 14 kolom (15 incl. data):   len=head[12], first_word=head[13]
    // Panjang head menentukan varian; "len" selalu di head.length-2.
    let isC5C6;
    if (head.length === 24) isC5C6 = false;
    else if (head.length === 14) isC5C6 = true;
    else return { ok: false, reason: `jumlah kolom metadata tidak dikenal: ${head.length}` };

    const lenField = Number(head[head.length - 2]);
    const raw = parseJsonIntArray(dataJson);
    if (!raw.ok) return { ok: false, reason: raw.reason };
    if (Number.isFinite(lenField) && lenField !== raw.values.length) {
        return { ok: false, reason: `len ${lenField} ≠ jumlah elemen ${raw.values.length}` };
    }

    // Interleaved [imag, real, ...] → complex per subcarrier.
    if (raw.values.length % 2 !== 0) {
        return { ok: false, reason: "jumlah elemen I/Q ganjil" };
    }
    const iqPairs = raw.values.length / 2;
    if (iqPairs === 0 || iqPairs > CAPTURE_LIMITS.MAX_IQ_PAIRS) {
        return { ok: false, reason: `jumlah pasangan I/Q di luar batas: ${iqPairs}` };
    }

    const amplitude = new Float32Array(iqPairs);
    const phase = new Float32Array(iqPairs);
    for (let i = 0; i < iqPairs; i++) {
        const imag = raw.values[i * 2];
        const real = raw.values[i * 2 + 1];
        amplitude[i] = Math.hypot(real, imag);
        phase[i] = Math.atan2(imag, real);
    }

    // Metadata berdasarkan varian (indeks MENTAH mengikuti DATA_COLUMNS_NAMES):
    // Standar: mac=2, rssi=3, noise_floor=14, channel=16, local_timestamp=18.
    // C5/C6:   mac=2, rssi=3, noise_floor=5,  channel=8, local_timestamp=9.
    const rssi = Number(head[3]);
    const channel = Number(isC5C6 ? head[8] : head[16]);
    const localTimestampUs = Number(isC5C6 ? head[9] : head[18]);
    const noiseFloor = Number(isC5C6 ? head[5] : head[14]);

    return {
        ok: true,
        frame: {
            sourceFormat: "esp-csi-csv",
            // MAC perangkat TIDAK dibawa keluar (privacy law) — pemanggil
            // memberi sensorId dari trusted composition.
            rssiDbm: Number.isFinite(rssi) ? rssi : null,
            channel: Number.isFinite(channel) ? channel : null,
            // PENTING (audit esp-csi): local_timestamp adalah MIKRODETIK
            // sejak boot (bukan epoch) — TIDAK bisa menjadi waktu dinding.
            // Disimpan sebagai penanda relatif; capturedAtMs diisi sumber
            // (waktu ingest dinding) — tidak pernah dikarang di sini.
            localTimestampUs: Number.isFinite(localTimestampUs) && localTimestampUs >= 0
                ? localTimestampUs : null,
            capturedAtMs: null,
            noiseFloorDbm: Number.isFinite(noiseFloor) ? noiseFloor : null,
            subcarriers: iqPairs,
            amplitude,
            phase
        }
    };
}

/** JSON array of int — bounded, tanpa eksekusi apa pun. */
function parseJsonIntArray(text) {
    if (text.length > CAPTURE_LIMITS.MAX_CSV_LINE_BYTES) {
        return { ok: false, reason: "payload data terlalu besar" };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { ok: false, reason: "data bukan JSON sah" };
    }
    if (!Array.isArray(parsed)) return { ok: false, reason: "data bukan array" };
    if (parsed.length > CAPTURE_LIMITS.MAX_IQ_PAIRS * 2) {
        return { ok: false, reason: "array data melebihi batas" };
    }
    const values = new Int16Array(parsed.length);
    for (let i = 0; i < parsed.length; i++) {
        const v = parsed[i];
        // E2: I/Q wajib INTEGER sah — desimal (1.5), NaN, Infinity,
        // 1e999 TIDAK pernah dibulatkan/dipotong jadi sampel CSI sah.
        if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) {
            return { ok: false, reason: `elemen ${i} bukan integer sah: ${String(v)}` };
        }
        values[i] = v;
    }
    return { ok: true, values };
}

/**
 * Parse satu frame biner RuView ADR-018 → CsiFrame | { ok:false }.
 * Layout (LE): [0..3] magic 0xC5110001, [4] node id, [5] antennas,
 * [6..7] subcarriers u16, [8..11] freq MHz u32, [12..15] seq u32,
 * [16] rssi i8, [17] noise floor i8, [18..19] reserved, [20..] I/Q bytes.
 */
function parseRuviewFrame(buffer) {
    if (!Buffer.isBuffer(buffer)) return { ok: false, reason: "input bukan Buffer" };
    if (buffer.length < ADR018_HEADER_SIZE) {
        return { ok: false, reason: "frame terlalu pendek" };
    }
    if (buffer.length > CAPTURE_LIMITS.MAX_FRAME_BYTES) {
        return { ok: false, reason: "frame melebihi batas ukuran" };
    }
    const magic = buffer.readUInt32LE(0);
    if (magic !== ADR018_MAGIC) {
        return { ok: false, reason: "magic ADR-018 tidak cocok" };
    }
    const nodeId = buffer.readUInt8(4);
    // E1: antenna count 0 TIDAK pernah diam-diam jadi 1 — reject.
    const antennas = buffer.readUInt8(5);
    if (antennas === 0) {
        return { ok: false, reason: "antenna count 0 tidak sah" };
    }
    const subcarriers = buffer.readUInt16LE(6);
    const freqMhz = buffer.readUInt32LE(8);
    const seq = buffer.readUInt32LE(12);
    const rssi = buffer.readInt8(16);
    const noiseFloor = buffer.readInt8(17);

    if (subcarriers === 0 || subcarriers > CAPTURE_LIMITS.MAX_SUBCARRIERS) {
        return { ok: false, reason: `jumlah subcarrier di luar batas: ${subcarriers}` };
    }
    // E1: aritmetika panjang yang mustahil (perkalian meluap jauh dari
    // batas frame) ditolak sebelum dipakai.
    const perSubBytes = 2 * antennas;
    const requiredBytes = ADR018_HEADER_SIZE + subcarriers * perSubBytes;
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > CAPTURE_LIMITS.MAX_FRAME_BYTES) {
        return { ok: false, reason: "aritmetika panjang frame tidak masuk akal" };
    }
    const iqBytes = buffer.length - ADR018_HEADER_SIZE;
    const availablePairs = Math.floor(iqBytes / perSubBytes);
    if (availablePairs < subcarriers) {
        return { ok: false, reason: `payload I/Q kurang: butuh ${subcarriers}, ada ${availablePairs}` };
    }
    // E1: payload di luar yang didokumentasikan = byte ekor asing → REJECT
    // (bounded parsing; tidak ada silent tolerance payload liar).
    if (buffer.length !== requiredBytes) {
        return { ok: false, reason: `panjang frame tidak persis: butuh ${requiredBytes}, dapat ${buffer.length} (payload ekor tidak diizinkan)` };
    }

    const amplitude = new Float32Array(subcarriers);
    const phase = new Float32Array(subcarriers);
    for (let sc = 0; sc < subcarriers; sc++) {
        // Antena berurutan per subcarrier: [sc][ant][i,q] (ADR-018: raw
        // I/Q dari ESP-IDF callback, antena interleaved per pasangan).
        const base = ADR018_HEADER_SIZE + sc * 2 * antennas;
        // V1: antena pertama (ESP32-S3 melaporkan 1 antena CSI).
        const real = buffer.readInt8(base);
        const imag = buffer.readInt8(base + 1);
        amplitude[sc] = Math.hypot(real, imag);
        phase[sc] = Math.atan2(imag, real);
    }

    return {
        ok: true,
        frame: {
            sourceFormat: "ruview-adr018",
            rssiDbm: rssi,
            channel: freqMhzToChannel(freqMhz),
            capturedAtMs: null, // diisi source (waktu kedatangan lokal)
            noiseFloorDbm: noiseFloor,
            subcarriers,
            sequence: seq,
            amplitude,
            phase
        }
    };
}

function freqMhzToChannel(freqMhz) {
    if (freqMhz >= 2412 && freqMhz <= 2472) return Math.round((freqMhz - 2412) / 5) + 1;
    if (freqMhz === 2484) return 14;
    if (freqMhz >= 5160 && freqMhz <= 5885) return Math.round((freqMhz - 5000) / 5);
    return null;
}

// ---- Source abstraction ----------------------------------------------------

/**
 * RfSource dasar — state jujur sesuai MD-009: sumber TIDAK "available"
 * sampai frame nyata diterima.
 */
class RfSource {
    /**
     * @param {{ id: string, kind: string, sensorId: string,
     *           maxRateHz?: number, clock?: { nowMs(): number } }} options
     */
    constructor({ id, kind, sensorId, maxRateHz = CAPTURE_LIMITS.DEFAULT_MAX_RATE_HZ, clock = null }) {
        if (!id || typeof id !== "string") throw new TypeError("RfSource butuh id");
        if (!Object.values(SOURCE_KIND).includes(kind)) {
            throw new TypeError(`jenis sumber tidak dikenal: ${kind}`);
        }
        if (!sensorId || typeof sensorId !== "string") {
            throw new TypeError("RfSource butuh sensorId (dari trusted composition)");
        }
        this.id = id;
        this.kind = kind;
        this.sensorId = sensorId;
        // Jam sumber mengikuti trusted composition (tes memakai jam tetap);
        // default = dinding. Replay men-stamp waktu dari jam INI, bukan
        // Date.now() mentah, agar tidak pernah "masa depan" vs layanan.
        this.clock = clock && typeof clock.nowMs === "function" ? clock : { nowMs: () => Date.now() };
        this.maxRateHz = Number.isFinite(maxRateHz) && maxRateHz > 0
            ? Math.min(maxRateHz, 1000) : CAPTURE_LIMITS.DEFAULT_MAX_RATE_HZ;

        this.framesReceived = 0;
        this.framesDropped = 0;
        this.lastFrameAtMs = null;
        this.state = "not_proven_yet"; // MD-009: belum AVAILABLE tanpa bukti
        this.failureReason = null;
        this._lastAcceptMs = 0;
        this._minIntervalMs = 1000 / this.maxRateHz;
    }

    /**
     * Terima satu frame mentah (sudah diparse). Rate-limit + ring buffer
     * ditangani di sini. Mengembalikan { ok, accepted?, reason? }.
     */
    ingestFrame(frame, { nowMs = Date.now() } = {}) {
        if (!frame || typeof frame !== "object") {
            this.framesDropped += 1;
            return { ok: false, reason: "frame tidak sah" };
        }
        // Rate limit: kelebihan laju dibuang (bukan diantri).
        if (this.lastFrameAtMs !== null &&
            nowMs - this._lastAcceptMs < this._minIntervalMs) {
            this.framesDropped += 1;
            return { ok: false, reason: "melebihi maxRateHz" };
        }
        this._lastAcceptMs = nowMs;
        this.framesReceived += 1;
        this.lastFrameAtMs = nowMs;
        // Frame nyata diterima = bukti hidup (MD-009).
        this.state = "available";
        this.failureReason = null;
        return { ok: true, accepted: true };
    }

    noteFailure(reason) {
        this.failureReason = String(reason).slice(0, 200);
        this.state = "unavailable";
    }

    describe() {
        return {
            id: this.id,
            kind: this.kind,
            sensorId: this.sensorId,
            state: this.state,
            failureReason: this.state === "available" ? null : this.failureReason,
            framesReceived: this.framesReceived,
            framesDropped: this.framesDropped,
            lastFrameAtMs: this.lastFrameAtMs,
            maxRateHz: this.maxRateHz
        };
    }
}

/**
 * Replay source — file .csi.csv / .ndjson lokal. OFFLINE-SAFE.
 * Dipakai untuk kalibrasi, uji, dan demo tanpa perangkat.
 */
class ReplayRfSource extends RfSource {
    constructor({ id, sensorId, filePath, format = null, maxRateHz, clock = null } = {}) {
        super({ id, kind: SOURCE_KIND.REPLAY, sensorId, maxRateHz, clock });
        this.filePath = filePath;
        this.format = format ?? (String(filePath).endsWith(".ndjson") ? "ndjson" : "esp-csi-csv");
    }

    /**
     * Baca file bounded, parse per baris, ingest frame yang sah.
     * Mengembalikan ringan: { ok, framesAccepted, framesDropped, errors[] }.
     */
    async load({ maxBytes = CAPTURE_LIMITS.MAX_FILE_BYTES, onFrame = null } = {}) {
        let stat;
        try {
            stat = fs.statSync(this.filePath);
        }
        catch {
            this.noteFailure("file replay tidak dapat dibaca");
            return { ok: false, reason: "file replay tidak dapat dibaca" };
        }
        if (stat.size > maxBytes) {
            this.noteFailure(`file replay > ${maxBytes} bytes`);
            return { ok: false, reason: `file replay melebihi batas ${maxBytes} bytes` };
        }

                // Jam replay: file esp-csi TIDAK membawa epoch (local_timestamp =
        // µs sejak boot). Waktu dinding dihitung mundur dari NOW pada saat
        // load: frame terakhir ≈ sekarang, frame lebih awal mundur sesuai
        // cadence maxRateHz — seluruh timeline di masa lampau, monotonik.
        const wallNow = this.clock.nowMs();

        const stream = fs.createReadStream(this.filePath, { encoding: "utf8" });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        const errors = [];
        const parsedFrames = [];
        let dropped = 0;
        let lineNo = 0;

        try {
            for await (const line of rl) {
                lineNo += 1;
                if (!line.trim()) continue;
                let result;
                if (this.format === "ndjson") {
                    result = parseNdjsonLine(line);
                }
                else {
                    result = parseEspCsiCsvLine(line);
                }
                if (!result.ok) {
                    dropped += 1;
                    if (errors.length < 20) errors.push({ line: lineNo, reason: result.reason });
                    continue;
                }
                parsedFrames.push(result.frame);
            }
        }
        finally {
            rl.close();
            stream.destroy();
        }

        // Batas jumlah frame yang di-replay per load (anti file raksasa).
        if (parsedFrames.length > CAPTURE_LIMITS.MAX_RING_FRAMES) {
            parsedFrames.splice(0, parsedFrames.length - CAPTURE_LIMITS.MAX_RING_FRAMES);
            dropped += 1; // penanda: ada yang dibuang
        }

        // Stamp waktu dinding retroaktif: terakhir ≈ wallNow.
        const total = parsedFrames.length;
        let accepted = 0;
        for (let i = 0; i < total; i++) {
            const frame = parsedFrames[i];
            const ageFromEnd = (total - 1 - i) * this._minIntervalMs;
            frame.capturedAtMs = wallNow - ageFromEnd;
            const verdict = this.ingestFrame(frame, { nowMs: frame.capturedAtMs });
            if (verdict.ok) {
                accepted += 1;
                if (onFrame) {
                    try { onFrame(frame); } catch { /* listener opsional */ }
                }
            }
            else {
                dropped += 1;
            }
        }

        if (accepted === 0) {
            // MD-009: nol frame sah = tidak terbukti hidup.
            this.noteFailure("tidak ada frame sah dalam file replay");
            return { ok: false, reason: "tidak ada frame sah", framesAccepted: 0, framesDropped: dropped, errors };
        }
        return { ok: true, framesAccepted: accepted, framesDropped: dropped, errors };
    }
}

/** NDJSON line → CsiFrame (metadata eksplisit + amplitude/phase array). */
function parseNdjsonLine(line) {
    if (Buffer.byteLength(line, "utf8") > CAPTURE_LIMITS.MAX_CSV_LINE_BYTES) {
        return { ok: false, reason: "baris melebihi batas" };
    }
    let obj;
    try {
        obj = JSON.parse(line);
    }
    catch {
        return { ok: false, reason: "bukan JSON sah" };
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return { ok: false, reason: "baris bukan objek" };
    }
    const amplitude = obj.amplitude;
    if (!Array.isArray(amplitude) || amplitude.length === 0 ||
        amplitude.length > CAPTURE_LIMITS.MAX_SUBCARRIERS) {
        return { ok: false, reason: "amplitude array tidak sah" };
    }
    const amp = new Float32Array(amplitude.length);
    for (let i = 0; i < amplitude.length; i++) {
        const v = amplitude[i];
        if (typeof v !== "number" || !Number.isFinite(v)) {
            return { ok: false, reason: `amplitude[${i}] bukan angka finite` };
        }
        amp[i] = v;
    }
    const phaseRaw = Array.isArray(obj.phase) ? obj.phase : null;
    const phase = new Float32Array(amplitude.length);
    if (phaseRaw) {
        for (let i = 0; i < Math.min(phaseRaw.length, amplitude.length); i++) {
            const v = phaseRaw[i];
            phase[i] = typeof v === "number" && Number.isFinite(v) ? v : 0;
        }
    }
    return {
        ok: true,
        frame: {
            sourceFormat: "ndjson",
            rssiDbm: Number.isFinite(obj.rssiDbm) ? obj.rssiDbm : null,
            channel: Number.isFinite(obj.channel) ? obj.channel : null,
            capturedAtMs: Number.isFinite(obj.capturedAtMs) ? obj.capturedAtMs : null,
            noiseFloorDbm: Number.isFinite(obj.noiseFloorDbm) ? obj.noiseFloorDbm : null,
            subcarriers: amplitude.length,
            amplitude: amp,
            phase
        }
    };
}

/**
 * UDP source — RuView ADR-018 di loopback. FAIL CLOSED pra-Lane4:
 * membutuhkan allowLocalUdp === true dari trusted composition, dan bind
 * address wajib loopback.
 */
class UdpRfSource extends RfSource {
    constructor({ id, sensorId, bindAddress = "127.0.0.1", bindPort = 0, maxRateHz, allowLocalUdp = false, onFrame = null }) {
        super({ id, kind: SOURCE_KIND.UDP, sensorId, maxRateHz });
        this.bindAddress = String(bindAddress);
        this.bindPort = Number.isFinite(bindPort) ? bindPort : 0;
        this._allowLocalUdp = allowLocalUdp === true;
        this.onFrame = typeof onFrame === "function" ? onFrame : null;
        this._socket = null;
    }

    _assertBindable() {
        const host = this.bindAddress;
        const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
        if (!this._allowLocalUdp) {
            return { ok: false, reason: "AUTHORIZED_LOCAL_SOURCE ditolak: allowLocalUdp tidak diberikan trusted composition (fail-closed pra-Lane4)" };
        }
        if (!isLoopback) {
            return { ok: false, reason: `bind address bukan loopback: ${host} — ditolak` };
        }
        return { ok: true };
    }

    /** Mulai menerima. Mengembalikan { ok, port? } — tidak pernah melempar. */
    async start() {
        const verdict = this._assertBindable();
        if (!verdict.ok) {
            this.noteFailure(verdict.reason);
            return { ok: false, reason: verdict.reason };
        }
        const dgram = require("node:dgram");
        const socket = dgram.createSocket("udp4");
        await new Promise((resolve) => {
            socket.once("error", (error) => {
                this.noteFailure(`udp bind gagal: ${error.message}`);
                resolve();
            });
            socket.bind(this.bindPort, this.bindAddress, () => resolve());
        });
        if (this.state === "unavailable" && this.failureReason) {
            try { socket.close(); } catch { /* sudah tertutup */ }
            return { ok: false, reason: this.failureReason };
        }
        const port = socket.address().port;
        socket.on("message", (msg) => {
            const result = parseRuviewFrame(msg);
            if (!result.ok) {
                this.framesDropped += 1;
                return;
            }
            this.ingestFrame(result.frame);
            this.lastFrame = result.frame;
            // PASS-THROUGH: hook manager sesi (optional) setelah ingest.
            if (this.onFrame) {
                try { this.onFrame(result.frame); } catch { /* callback opsional */ }
            }
        });
        this._socket = socket;
        return { ok: true, port };
    }

    stop() {
        if (this._socket) {
            try { this._socket.close(); } catch { /* sudah tertutup */ }
            this._socket = null;
        }
    }
}

/** Ring buffer frame mentah (bounded). */
class CsiRingBuffer {
    constructor({ capacity = CAPTURE_LIMITS.MAX_RING_FRAMES } = {}) {
        this.capacity = Number.isFinite(capacity) && capacity > 0
            ? Math.min(capacity, CAPTURE_LIMITS.MAX_RING_FRAMES) : CAPTURE_LIMITS.MAX_RING_FRAMES;
        this.frames = [];
        this.dropped = 0;
    }

    push(frame) {
        if (!frame || typeof frame !== "object") return false;
        if (this.frames.length >= this.capacity) {
            this.frames.shift(); // buang terlama
            this.dropped += 1;
        }
        this.frames.push(frame);
        return true;
    }

    latest(n = 1) {
        return this.frames.slice(-Math.max(1, Math.min(n, this.capacity)));
    }

    get size() { return this.frames.length; }

    clear() {
        this.frames = [];
        this.dropped = 0;
    }
}

module.exports = Object.freeze({
    CAPTURE_LIMITS,
    ADR018_MAGIC,
    ADR018_HEADER_SIZE,
    SOURCE_KIND,
    parseEspCsiCsvLine,
    parseRuviewFrame,
    parseNdjsonLine,
    RfSource,
    ReplayRfSource,
    UdpRfSource,
    CsiRingBuffer
});
