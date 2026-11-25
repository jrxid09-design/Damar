"use strict";

/**
 * speakerProfiles — penyimpanan voiceprint lokal TERENKRIPSI.
 *
 * Profil pembicara (embedding + metadata) disimpan sebagai satu berkas
 * terenkripsi AES-256-GCM di data/voice/speakers.enc (gitignored, data
 * per-instalasi). Kunci berasal dari berkas kunci lokal
 * data/voice/speakers.key (dibuat acak saat enroll pertama) atau env
 * DAMAR_VOICE_PROFILE_KEY. Yang disimpan adalah VEKTOR embedding —
 * BUKAN audio mentah; audio enrollment tidak pernah ditulis ke disk.
 *
 * Satu komponen dipakai bersama oleh jalur interaksi (Core tahu siapa
 * yang bicara → tingkat kewenangan mengikuti identitas) dan jalur
 * approval suara (voiceApproval.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { extractEmbedding, cosineSim } = require("./speakerEmbed");
const { voiceLocalRoot } = require("../local/engines");

function defaultPaths() {
    const root = voiceLocalRoot();
    return {
        file: path.join(root, "speakers.enc"),
        keyFile: path.join(root, "speakers.key")
    };
}

function loadKey(keyFile) {
    if (process.env.DAMAR_VOICE_PROFILE_KEY) {
        return crypto.createHash("sha256").update(process.env.DAMAR_VOICE_PROFILE_KEY).digest();
    }
    if (fs.existsSync(keyFile)) {
        return crypto.createHash("sha256").update(fs.readFileSync(keyFile)).digest();
    }
    return null;
}

function ensureKey(keyFile) {
    let key = loadKey(keyFile);
    if (key) return key;
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    const raw = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, raw.toString("hex"), { mode: 0o600 });
    return crypto.createHash("sha256").update(raw.toString("hex")).digest();
}

class SpeakerProfiles {

    constructor({ file, keyFile } = {}) {
        const d = defaultPaths();
        this.file = file || d.file;
        this.keyFile = keyFile || d.keyFile;
        this._profiles = null; // Map<id, {id, role, embedding:number[], samples, enrolledAt}>
    }

    _load() {
        if (this._profiles) return this._profiles;
        this._profiles = new Map();
        const key = loadKey(this.keyFile);
        if (!key || !fs.existsSync(this.file)) return this._profiles;
        try {
            const blob = JSON.parse(fs.readFileSync(this.file, "utf8"));
            const iv = Buffer.from(blob.iv, "base64");
            const tag = Buffer.from(blob.tag, "base64");
            const data = Buffer.from(blob.data, "base64");
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
            for (const p of JSON.parse(plain).profiles || []) this._profiles.set(p.id, p);
        } catch {
            // Berkas rusak / kunci salah: mulai kosong daripada menebak.
            this._profiles = new Map();
        }
        return this._profiles;
    }

    _save() {
        const key = ensureKey(this.keyFile);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const plain = JSON.stringify({ profiles: [...this._load().values()] });
        const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
            iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64")
        }), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    /**
     * Daftarkan / perbarui pembicara dari beberapa sampel WAV.
     * Embedding profil = rata-rata embedding sampel (dinormalisasi ulang).
     * @param {string} id identitas pembicara (mis. "owner")
     * @param {Buffer[]} wavBuffers sampel ucapan (WAV 16 kHz)
     * @param {object} [opts] { role: "owner" | "registered" }
     */
    enroll(id, wavBuffers, { role = "registered" } = {}) {
        if (!id || !Array.isArray(wavBuffers) || wavBuffers.length === 0) {
            throw new Error("enroll butuh id + minimal satu sampel WAV");
        }
        const embs = wavBuffers.map(b => extractEmbedding(b));
        const dim = embs[0].length;
        const avg = new Float32Array(dim);
        for (const e of embs) for (let i = 0; i < dim; i++) avg[i] += e[i] / embs.length;
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < dim; i++) avg[i] /= norm;

        const profile = {
            id: String(id), role,
            embedding: [...avg],
            samples: wavBuffers.length,
            enrolledAt: new Date().toISOString()
        };
        this._load().set(profile.id, profile);
        this._save();
        return { id: profile.id, role: profile.role, samples: profile.samples };
    }

    /** Daftar profil (tanpa embedding). */
    list() {
        return [...this._load().values()].map(p => ({ id: p.id, role: p.role, samples: p.samples, enrolledAt: p.enrolledAt }));
    }

    remove(id) {
        const had = this._load().delete(String(id));
        if (had) this._save();
        return had;
    }

    /**
     * Identifikasi pembicara dari satu ucapan.
     * @returns {{ speakerId: string|null, role: string, score: number,
     *             runnerUp: {id: string, score: number}|null, known: boolean }}
     * known=false berarti "unknown" (tamu) — skor terbaik di bawah ambang.
     */
    identify(wavBuffer, { threshold = 0.90 } = {}) {
        const emb = extractEmbedding(wavBuffer);
        let best = null, second = null;
        for (const p of this._load().values()) {
            const score = cosineSim(emb, p.embedding);
            if (!best || score > best.score) { second = best; best = { id: p.id, role: p.role, score }; }
            else if (!second || score > second.score) { second = { id: p.id, role: p.role, score }; }
        }
        if (!best) return { speakerId: null, role: "guest", score: 0, runnerUp: null, known: false };
        const known = best.score >= threshold;
        return {
            speakerId: known ? best.id : null,
            role: known ? best.role : "guest",
            score: Number(best.score.toFixed(4)),
            bestMatch: { id: best.id, score: Number(best.score.toFixed(4)) },
            runnerUp: second ? { id: second.id, score: Number(second.score.toFixed(4)) } : null,
            known
        };
    }

    /**
     * Verifikasi klaim identitas (untuk approval suara): apakah ucapan ini
     * cocok dengan profil `id`?
     * @returns {{ match: boolean, score: number, threshold: number }}
     */
    verify(id, wavBuffer, { threshold = 0.95 } = {}) {
        const p = this._load().get(String(id));
        if (!p) return { match: false, score: 0, threshold, reason: "PROFILE_NOT_FOUND" };
        const score = cosineSim(extractEmbedding(wavBuffer), p.embedding);
        return { match: score >= threshold, score: Number(score.toFixed(4)), threshold };
    }
}

module.exports = { SpeakerProfiles };
