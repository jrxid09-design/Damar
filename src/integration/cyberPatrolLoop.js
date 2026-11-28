"use strict";

/**
 * DAMAR CYBER — Werkudara patrol loop (composition layer).
 *
 * Owner direction 2026-11-28: Cyber patrols must not wait to be asked.
 * This loop lives in the canonical daemon composition (wired by
 * riProductionComposition, next to the single DCD detection engine) and
 * runs Werkudara's two patrol kinds automatically while the daemon is up:
 *
 *   - PATROLI SISTEM   host state assessment (resources, processes)
 *   - PATROLI JARINGAN network state assessment (listeners, connections)
 *
 * Every cycle gathers REAL read-only evidence from the host (os module,
 * netstat, tasklist) and has it ASSESSED BY THE MODEL: Werkudara's
 * judgment, findings, severity and Indonesian summary come from an LLM
 * call (owner order 2026-11-28 17:41 WIB: patrols must use an LLM). The
 * model is chosen per cycle by the single named resolver in
 * patrolModel.js (Werkudara's own per-Pandawa assignment first, the
 * daemon's provider selection as fallback), and every record names the
 * engine that produced it: engine 'llm' with provider + model +
 * modelSource, or engine 'deterministik' when the LLM could not be
 * reached on that cycle — in which case the deterministic rules in this
 * module produce the assessment and the record carries the failure
 * reason (llmError). A deterministic record is never presented as an
 * LLM patrol. Records are appended to the durable journal in the
 * canonical ACC store. A cycle whose evidence cannot be gathered is
 * recorded FAILED with the reason, and a failed cycle never stops the
 * loop or the daemon. Patrols are assessments only; any action beyond
 * assessment stays behind the Authority Gate as designed, exactly like
 * the manual patrols recorded through the Pandawa registry.
 *
 * The cadence lives in ONE named place: PATROL_CADENCE below. The daemon
 * composition has no settings surface, so the intervals are constants
 * there, with optional operator overrides via DAMAR_CYBER_PATROL_SISTEM_MS
 * and DAMAR_CYBER_PATROL_JARINGAN_MS (positive milliseconds, min 30 s).
 * The loop's own state() is the only source the surfaces may use to call
 * the patrol mode periodic: mode is "berkala" only while the timers are
 * actually running.
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const PATROL_CADENCE = Object.freeze({
    sistemMs: 15 * 60_000,
    jaringanMs: 30 * 60_000,
    firstSistemDelayMs: 60_000,
    firstJaringanDelayMs: 150_000
});

const JOURNAL_KEY = "cyber:patrol:journal";
const JOURNAL_MAX = 60;

// Ports whose exposure is a named risk when reachable beyond loopback,
// and worth a note even on loopback (remote debugging and remote access).
const RISKY_PORTS = Object.freeze({
    9222: "debug jarak jauh Chromium",
    9229: "debug Node atau Chromium",
    5900: "VNC",
    3389: "Remote Desktop",
    23: "Telnet",
    21: "FTP",
    445: "SMB",
    135: "RPC"
});

const SEVERITY_RANK = { TINGGI: 0, SEDANG: 1, RENDAH: 2, INFO: 3 };

function resolveInterval(envValue, fallback) {
    const n = Number(envValue);
    if (Number.isSafeInteger(n) && n >= 30_000 && n <= 24 * 60 * 60_000) return n;
    return fallback;
}

function isLoopback(addr) {
    return addr === "::1" || addr === "localhost" || addr.startsWith("127.");
}

function splitAddrPort(text) {
    const i = text.lastIndexOf(":");
    if (i < 0) return { addr: text, port: NaN };
    return { addr: text.slice(0, i).replace(/^\[/, "").replace(/\]$/, ""), port: Number(text.slice(i + 1)) };
}

/** Parse `netstat -ano -p TCP` output into listeners + external connections. */
function parseNetstat(text) {
    const listeners = [];
    let externalConnections = 0;
    const remotes = new Set();
    for (const line of String(text || "").split(/\r?\n/)) {
        const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+([A-Za-z_]+)\s+(\d+)\s*$/.exec(line);
        if (!m) continue;
        const local = splitAddrPort(m[1]);
        const remote = splitAddrPort(m[2]);
        const state = m[3].toUpperCase();
        const pid = Number(m[4]);
        if (state === "LISTENING") {
            listeners.push({ addr: local.addr, port: local.port, pid, scope: isLoopback(local.addr) ? "loopback" : "jaringan" });
        } else if (state === "ESTABLISHED" && remote.addr && remote.addr !== "0.0.0.0" && remote.addr !== "::" && !isLoopback(remote.addr)) {
            externalConnections += 1;
            remotes.add(remote.addr);
        }
    }
    return { listeners, externalConnections, uniqueRemoteCount: remotes.size };
}

function sortFindings(findings) {
    return findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

/** Deterministic assessment of one network snapshot. Pure; testable. */
function assessJaringan(snapshot) {
    const findings = [];
    const external = snapshot.listeners.filter(l => l.scope === "jaringan");
    for (const l of external) {
        const label = RISKY_PORTS[l.port];
        if (label) findings.push({ severity: "TINGGI", text: `Port ${l.port} (${label}) mendengarkan di ${l.addr} (PID ${l.pid}), terbuka ke jaringan.` });
        else findings.push({ severity: "SEDANG", text: `Listener ${l.addr}:${l.port} (PID ${l.pid}) terbuka ke jaringan.` });
    }
    for (const l of snapshot.listeners) {
        if (l.scope !== "loopback") continue;
        const label = RISKY_PORTS[l.port];
        if (label) findings.push({ severity: "RENDAH", text: `Port ${l.port} (${label}) aktif hanya di loopback (PID ${l.pid}).` });
    }
    sortFindings(findings);
    const top = findings[0];
    const summary = `Berkala: ${snapshot.listeners.length} listener (${external.length} terbuka ke jaringan), ${snapshot.externalConnections} koneksi eksternal aktif ke ${snapshot.uniqueRemoteCount} alamat. ${top ? top.text : "Tidak ada paparan berisiko terdeteksi."}`;
    return { findings: findings.slice(0, 12), summary: summary.slice(0, 300) };
}

function formatUptime(totalSec) {
    const sec = Math.max(0, Math.floor(totalSec || 0));
    const jam = Math.floor(sec / 3600);
    const menit = Math.floor((sec % 3600) / 60);
    return `${jam} jam ${menit} menit`;
}

/** Deterministic assessment of one host-state snapshot. Pure; testable. */
function assessSistem(ev) {
    const findings = [];
    if (typeof ev.diskFreePct === "number" && ev.diskFreePct < 10) {
        findings.push({ severity: "SEDANG", text: `Ruang bebas disk sistem tinggal ${ev.diskFreePct}%.` });
    }
    if (typeof ev.memFreePct === "number" && ev.memFreePct < 10) {
        findings.push({ severity: "SEDANG", text: `Memori bebas tinggal ${ev.memFreePct}%.` });
    }
    if (ev.processCount === null || ev.processCount === undefined) {
        findings.push({ severity: "RENDAH", text: "Jumlah proses tidak terbaca pada siklus ini." });
    }
    sortFindings(findings);
    const top = findings[0];
    const diskPart = typeof ev.diskFreePct === "number" ? `, disk bebas ${ev.diskFreeGB} GB (${ev.diskFreePct}%)` : "";
    const summary = `Berkala: host ${ev.hostname}, uptime ${formatUptime(ev.uptimeHostSec)}, memori bebas ${ev.memFreePct}%${diskPart}, ${ev.processCount ?? "-"} proses berjalan. ${top ? top.text : "Kondisi sistem normal."}`;
    return { findings: findings.slice(0, 12), summary: summary.slice(0, 300) };
}

function execText(file, args, timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout || ""));
        });
    });
}

async function gatherJaringan() {
    const text = await execText("netstat", ["-ano", "-p", "TCP"]);
    const snap = parseNetstat(text);
    return {
        snapshot: snap,
        evidence: {
            listenerCount: snap.listeners.length,
            externalListenerCount: snap.listeners.filter(l => l.scope === "jaringan").length,
            externalConnections: snap.externalConnections,
            uniqueRemoteCount: snap.uniqueRemoteCount,
            listeners: snap.listeners.slice(0, 20).map(l => ({ addr: l.addr, port: l.port, pid: l.pid, scope: l.scope }))
        }
    };
}

async function gatherSistem() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    let disk = {};
    try {
        const st = fs.statfsSync(path.parse(process.cwd()).root);
        const total = st.blocks * st.bsize;
        const free = st.bavail * st.bsize;
        if (total > 0) disk = { diskFreeBytes: free, diskTotalBytes: total, diskFreePct: Math.round((free / total) * 1000) / 10, diskFreeGB: Math.round((free / 1_073_741_824) * 10) / 10 };
    } catch { /* disk evidence is best-effort; its absence is not a failure */ }
    let processCount = null;
    try {
        const out = await execText("tasklist", ["/NH", "/FO", "CSV"], 10_000);
        processCount = out.split(/\r?\n/).filter(l => l.startsWith('"')).length;
    } catch { processCount = null; }
    const ev = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptimeHostSec: Math.floor(os.uptime()),
        daemonUptimeSec: Math.floor(process.uptime()),
        memFreeBytes: freeMem,
        memTotalBytes: totalMem,
        memFreePct: totalMem > 0 ? Math.round((freeMem / totalMem) * 1000) / 10 : 0,
        processCount,
        ...disk
    };
    return { snapshot: ev, evidence: ev };
}

/**
 * Create the patrol loop. `acc` is the canonical ACC store of the
 * composition (durable journal); `clock` and `broadcast` are the
 * composition's own seams. `llm` is the patrolModel.js seam
 * ({ resolveTarget, assess }): when present, each cycle's evidence is
 * assessed by the model; when absent or failing, the cycle falls back
 * to the deterministic assessment under its own label. Nothing in here
 * throws into the caller.
 */
function createCyberPatrolLoop({ acc = null, clock = () => Date.now(), broadcast = null, env = process.env, llm = null } = {}) {
    const cadence = {
        sistemMs: resolveInterval(env.DAMAR_CYBER_PATROL_SISTEM_MS, PATROL_CADENCE.sistemMs),
        jaringanMs: resolveInterval(env.DAMAR_CYBER_PATROL_JARINGAN_MS, PATROL_CADENCE.jaringanMs),
        firstSistemDelayMs: PATROL_CADENCE.firstSistemDelayMs,
        firstJaringanDelayMs: PATROL_CADENCE.firstJaringanDelayMs
    };
    const kinds = {
        sistem: { intervalMs: cadence.sistemMs, firstDelayMs: cadence.firstSistemDelayMs, timer: null, firstTimer: null, inFlight: false, lastRunAt: null, lastState: null, nextRunAt: null },
        jaringan: { intervalMs: cadence.jaringanMs, firstDelayMs: cadence.firstJaringanDelayMs, timer: null, firstTimer: null, inFlight: false, lastRunAt: null, lastState: null, nextRunAt: null }
    };
    let started = false;
    let startedAt = null;
    let journal = [];
    let journalLoaded = false;
    let persistChain = Promise.resolve();
    // The model the most recent cycle resolved (names only, never a key):
    // surfaced through state() so the projections can say which model the
    // patrols judge with and where that choice came from.
    let llmState = null;

    async function loadJournal() {
        if (journalLoaded) return;
        journalLoaded = true;
        if (!acc || typeof acc.getKv !== "function") return;
        try {
            const stored = await acc.getKv(JOURNAL_KEY);
            if (Array.isArray(stored)) journal = stored.filter(r => r && typeof r === "object" && typeof r.patrolId === "string").slice(-JOURNAL_MAX);
            for (const r of journal) {
                const k = kinds[r.kind];
                if (k && (k.lastRunAt === null || (r.finishedAt || 0) > k.lastRunAt)) { k.lastRunAt = r.finishedAt || r.startedAt || null; k.lastState = r.state || null; }
            }
        } catch { /* a journal read fault degrades to this process's own records */ }
    }

    function persist() {
        if (!acc || typeof acc.putKv !== "function") return persistChain;
        const snapshot = journal.slice(-JOURNAL_MAX);
        persistChain = persistChain.then(() => acc.putKv(JOURNAL_KEY, snapshot)).catch(() => {});
        return persistChain;
    }

    async function runCycle(kind) {
        const k = kinds[kind];
        if (!k || k.inFlight) return null;
        k.inFlight = true;
        const startedCycleAt = clock();
        let record;
        try {
            await loadJournal();
            const gathered = kind === "sistem" ? await gatherSistem() : await gatherJaringan();
            const deterministic = kind === "sistem" ? assessSistem(gathered.snapshot) : assessJaringan(gathered.snapshot);
            // Assessment by the model when the patrol LLM seam is wired:
            // the resolver picks the model fresh each cycle (Werkudara's
            // assignment first, daemon provider selection as fallback).
            // Any failure keeps the deterministic assessment, labeled as
            // such, with the reason recorded — never dressed as LLM work.
            let assessed = deterministic;
            let engine = "deterministik";
            let modelFields = { provider: null, model: null, modelSource: null };
            let llmError = null;
            if (llm && typeof llm.resolveTarget === "function" && typeof llm.assess === "function") {
                let target = null;
                try { target = llm.resolveTarget(); } catch { target = null; }
                if (target) {
                    modelFields = { provider: target.provider || null, model: target.model || null, modelSource: target.modelSource || null };
                    llmState = { ...modelFields };
                    if (target.model && target.endpoint) {
                        try {
                            assessed = await llm.assess({ kind, evidence: gathered.evidence, target });
                            engine = "llm";
                        } catch (err) {
                            // One retry on a bare timeout: provider
                            // latency on the owner's route is bursty, and
                            // the cycle has room (in-flight guard, long
                            // cadence). Any second failure is recorded.
                            if (err && err.message === "LLM_TIMEOUT") {
                                try {
                                    assessed = await llm.assess({ kind, evidence: gathered.evidence, target });
                                    engine = "llm";
                                } catch (err2) {
                                    llmError = String(err2 && err2.message ? err2.message : err2).slice(0, 80);
                                }
                            } else {
                                llmError = String(err && err.message ? err.message : err).slice(0, 80);
                            }
                        }
                    } else {
                        llmError = target.unavailableReason || "LLM_TIDAK_TERSEDIA";
                    }
                } else {
                    llmError = "LLM_RESOLVER_GAGAL";
                }
            }
            record = {
                patrolId: "pat_" + crypto.randomUUID().replace(/-/g, ""),
                kind,
                worker: "werkudara",
                origin: "daemon",
                task: kind === "sistem" ? "PATROLI SISTEM (otomatis)" : "PATROLI JARINGAN (otomatis)",
                state: "COMPLETED",
                startedAt: startedCycleAt,
                finishedAt: clock(),
                summary: assessed.summary,
                findings: assessed.findings,
                evidence: gathered.evidence,
                engine,
                provider: modelFields.provider,
                model: modelFields.model,
                modelSource: modelFields.modelSource,
                llmError,
                error: null
            };
        } catch (err) {
            record = {
                patrolId: "pat_" + crypto.randomUUID().replace(/-/g, ""),
                kind,
                worker: "werkudara",
                origin: "daemon",
                task: kind === "sistem" ? "PATROLI SISTEM (otomatis)" : "PATROLI JARINGAN (otomatis)",
                state: "FAILED",
                startedAt: startedCycleAt,
                finishedAt: clock(),
                summary: `Patroli ${kind} berkala gagal dijalankan pada siklus ini: ${String(err && err.message ? err.message : err).slice(0, 120)}`,
                findings: [],
                evidence: {},
                engine: null,
                provider: null,
                model: null,
                modelSource: null,
                llmError: null,
                error: "PATROL_CYCLE_FAILED"
            };
        }
        record.durationMs = Math.max(0, record.finishedAt - record.startedAt);
        journal = [...journal, record].slice(-JOURNAL_MAX);
        k.lastRunAt = record.finishedAt;
        k.lastState = record.state;
        k.inFlight = false;
        await persist();
        if (typeof broadcast === "function") {
            try { broadcast({ type: "patrol.completed", patrolId: record.patrolId, kind, state: record.state, occurredAt: record.finishedAt }); } catch { /* best effort */ }
        }
        return record;
    }

    function tick(kind) {
        const k = kinds[kind];
        k.nextRunAt = clock() + k.intervalMs;
        runCycle(kind).catch(() => { /* runCycle never throws by design; belt and braces */ });
    }

    function start() {
        if (started) return state();
        started = true;
        startedAt = clock();
        loadJournal().catch(() => {});
        // Resolve the patrol model once up front so state() can name it
        // before the first cycle lands; cycles keep re-resolving.
        if (llm && typeof llm.resolveTarget === "function") {
            try { const t = llm.resolveTarget(); if (t) llmState = { provider: t.provider || null, model: t.model || null, modelSource: t.modelSource || null }; } catch { /* cycles retry */ }
        }
        for (const kind of Object.keys(kinds)) {
            const k = kinds[kind];
            k.nextRunAt = startedAt + k.firstDelayMs;
            k.firstTimer = setTimeout(() => {
                tick(kind);
                k.timer = setInterval(() => tick(kind), k.intervalMs);
                if (k.timer.unref) k.timer.unref();
            }, k.firstDelayMs);
            if (k.firstTimer.unref) k.firstTimer.unref();
        }
        return state();
    }

    function stop() {
        for (const k of Object.values(kinds)) {
            if (k.firstTimer) clearTimeout(k.firstTimer);
            if (k.timer) clearInterval(k.timer);
            k.firstTimer = null;
            k.timer = null;
            k.nextRunAt = null;
        }
        started = false;
    }

    function kindState(k) {
        return { intervalMs: k.intervalMs, lastRunAt: k.lastRunAt, lastState: k.lastState, nextRunAt: started ? k.nextRunAt : null };
    }

    function state() {
        return {
            mode: started ? "berkala" : "nonaktif",
            startedAt,
            sistem: kindState(kinds.sistem),
            jaringan: kindState(kinds.jaringan),
            llm: llmState ? { ...llmState } : null
        };
    }

    function recent(n = 12) {
        return journal.slice(-Math.max(1, n)).reverse();
    }

    return { start, stop, state, recent, runCycle, cadence };
}

module.exports = { createCyberPatrolLoop, PATROL_CADENCE, parseNetstat, assessJaringan, assessSistem };
