"use strict";

/**
 * voiceApproval — approval lewat suara sebagai JALUR AUTHORITY RESMI
 * (keputusan owner 2026-11-25 11:46 WIB), BUKAN bypass Authority Gate.
 *
 * Owner bisa menyetujui/menolak permintaan approval yang pending dengan
 * suara ("setuju" / "jalankan" / "tolak"). Agar kanal ini sah, keputusan
 * diikat pada VERIFIKASI PEMBICARA lokal (speakerProfiles):
 *
 *   1. Ucapan harus terbaca sebagai frasa approval/penolakan yang jelas
 *      (parseApprovalUtterance — frasa pendek, kata utuh).
 *   2. Pembicara harus teridentifikasi sebagai profil berperan "owner"
 *      DAN lolos verifikasi terhadap profil owner dengan skor >= ambang.
 *      Suara orang lain tetap bisa berinteraksi (STT jalan) tapi
 *      keputusannya DITOLAK di sini.
 *   3. Tier risiko tinggi TIDAK bisa disetujui lewat suara dalam pass
 *      ini (fallback konservatif) — tetap lewat klik. Ini disengaja dan
 *      tercatat, bukan kelonggaran diam-diam.
 *   4. SETIAP percobaan (diterima maupun ditolak) ditulis ke audit
 *      append-only (default: data/voice/voice-approvals.jsonl) dengan
 *      skor kecocokan pembicara — mengikuti pola ledger repo.
 *
 * Komponen ini adalah fungsi keputusan murni di tepi kanal suara; Core
 * memanggil decide() dengan id permintaan pending + audio ucapan, lalu
 * menjalankan keputusan lewat Authority Gate seperti biasa.
 */

const fs = require("node:fs");
const path = require("node:path");

const { voiceLocalRoot } = require("./local/engines");

const APPROVE_PHRASES = Object.freeze([
    "setuju", "saya setuju", "aku setuju", "jalankan", "jalankan saja",
    "ya jalankan", "iya jalankan", "oke jalankan", "ok jalankan",
    "oke", "ok", "ya", "iya", "boleh", "silakan", "lanjutkan", "setujui"
]);
const DENY_PHRASES = Object.freeze([
    "tolak", "saya tolak", "aku tolak", "jangan", "jangan jalankan",
    "tidak", "tidak setuju", "batal", "batalkan", "berhenti", "stop"
]);

function normalize(text) {
    return String(text ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Baca ucapan sebagai keputusan approval.
 * Hanya frasa PENDEK (<= 5 kata) yang diawali/diakhiri frasa keputusan
 * yang dikenali — kalimat panjang yang kebetulan memuat "ya" tidak dihitung.
 * @returns {"approve"|"deny"|null}
 */
function parseApprovalUtterance(text) {
    const t = normalize(text);
    if (!t) return null;
    const words = t.split(" ");
    if (words.length > 5) return null;
    if (DENY_PHRASES.includes(t)) return "deny";
    if (APPROVE_PHRASES.includes(t)) return "approve";
    // Pola "ya, setuju" / "tolak saja" — cek frasa di awal/akhir.
    for (const p of DENY_PHRASES) if (t.startsWith(p + " ") || t.endsWith(" " + p)) return "deny";
    for (const p of APPROVE_PHRASES) if (t.startsWith(p + " ") || t.endsWith(" " + p)) return "approve";
    return null;
}

/** Audit sink default: JSONL append-only di data/voice (pola ledger repo). */
function defaultAuditSink(entry) {
    const file = path.join(voiceLocalRoot(), "voice-approvals.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

class VoiceApprovalGate {

    /**
     * @param {object} opts
     * @param {object} opts.profiles SpeakerProfiles (wajib)
     * @param {Function} [opts.audit] sink (entry) => void
     * @param {number} [opts.verifyThreshold] ambang verifikasi owner (default 0.95, dikalibrasi dari matriks uji)
     * @param {number} [opts.identifyThreshold] ambang identifikasi (default 0.90, dikalibrasi dari matriks uji)
     * @param {boolean} [opts.allowHighTier] default false — konservatif
     */
    constructor({ profiles, audit = defaultAuditSink, verifyThreshold = 0.95, identifyThreshold = 0.90, allowHighTier = false } = {}) {
        if (!profiles) throw new Error("VoiceApprovalGate butuh SpeakerProfiles");
        this.profiles = profiles;
        this.audit = audit;
        this.verifyThreshold = verifyThreshold;
        this.identifyThreshold = identifyThreshold;
        this.allowHighTier = allowHighTier;
    }

    /**
     * Putuskan satu percobaan approval suara.
     * @param {object} req { pendingId, wavBuffer, text, riskTier }
     * @returns {Promise<{ accepted: boolean, decision: "approve"|"deny"|null,
     *           reason: string, speaker: object }>}
     */
    async decide({ pendingId, wavBuffer, text, riskTier = "low" } = {}) {
        const at = new Date().toISOString();
        const decision = parseApprovalUtterance(text);
        const finish = (accepted, reason, speaker) => {
            const entry = {
                at, channel: "voice", pendingId: pendingId ?? null,
                utterance: String(text ?? "").slice(0, 120), decision,
                accepted, reason, riskTier,
                speakerId: speaker?.speakerId ?? null,
                speakerScore: speaker?.score ?? null
            };
            try { this.audit(entry); } catch { /* audit gagal tidak mengubah keputusan */ }
            return { accepted, decision, reason, speaker, audit: entry };
        };

        if (!decision) return finish(false, "NOT_AN_APPROVAL_UTTERANCE", null);
        if (!wavBuffer || wavBuffer.length === 0) return finish(false, "NO_AUDIO", null);

        let identity;
        try {
            identity = this.profiles.identify(wavBuffer, { threshold: this.identifyThreshold });
        } catch (error) {
            return finish(false, `IDENTIFY_FAILED:${error.message}`, null);
        }
        if (!identity.known || identity.role !== "owner") {
            return finish(false, "SPEAKER_NOT_OWNER", identity);
        }
        const verification = this.profiles.verify(identity.speakerId, wavBuffer, { threshold: this.verifyThreshold });
        if (!verification.match) {
            return finish(false, "SPEAKER_SCORE_LOW", { ...identity, verifyScore: verification.score });
        }
        if (riskTier === "high" && !this.allowHighTier) {
            return finish(false, "HIGH_TIER_REQUIRES_CLICK", { ...identity, verifyScore: verification.score });
        }
        return finish(true, "OWNER_VERIFIED", { ...identity, verifyScore: verification.score });
    }
}

module.exports = { VoiceApprovalGate, parseApprovalUtterance, APPROVE_PHRASES, DENY_PHRASES, normalize };
