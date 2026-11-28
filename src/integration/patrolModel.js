"use strict";

/**
 * DAMAR CYBER — Werkudara patrol model resolution + LLM assessment.
 *
 * Owner order 2026-11-28 17:41 WIB: "Werkudara dan agent lain harus pake
 * llm" — patrol assessment is the model's judgment, not deterministic
 * rules. Owner clarification 17:42 WIB: a Pandawa's model is independent
 * of Damar's main model, so the patrol's model comes from ONE named
 * resolver, resolveWerkudaraPatrolModel():
 *
 *   1. Werkudara's own per-Pandawa assignment in the Core settings file
 *      (`pandawa.models.werkudara`, '<connectionId>/<model>' or null;
 *      the same contract the desktop Core's pandawa-team.cjs validates
 *      and the Control Pandawa page writes). The assignment decides the
 *      MODEL; transport is the daemon's configured OpenAI-compatible
 *      endpoint, which in the owner's installation is the same local
 *      9router the Core connection points at.
 *   2. Only when Werkudara has no assignment: the daemon's own provider
 *      selection (src/services/providerConfigService resolveActive(),
 *      configs/providers.json) — provider + model as configured there.
 *
 * The resolver is re-read on every patrol cycle, so an assignment the
 * owner changes in Control takes effect on the next cycle without a
 * daemon restart. Nothing here invents a model: when neither source
 * yields a dispatchable model, the resolver says so and the patrol loop
 * records its deterministic assessment under its own honest label.
 *
 * The API key comes only from the daemon's own provider configuration
 * (providerConfigService), stays in this process, and is never returned,
 * logged, or written into a patrol record.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Same reference shape the Core validates for per-Pandawa assignments
// (apps/desktop/src/core-host/pandawa-team.cjs MODEL_REF).
const MODEL_REF = /^[a-z0-9][a-z0-9-]{0,31}\/[A-Za-z0-9._:\/@+-]{1,128}$/;
const SEVERITIES = new Set(["TINGGI", "SEDANG", "RENDAH", "INFO"]);
const SEVERITY_RANK = { TINGGI: 0, SEDANG: 1, RENDAH: 2, INFO: 3 };

/** The Core settings file the daemon can read (the owner's profile). */
function defaultCoreSettingsFile(env = process.env) {
    if (env.DAMAR_CORE_SETTINGS_FILE && path.isAbsolute(env.DAMAR_CORE_SETTINGS_FILE)) return env.DAMAR_CORE_SETTINGS_FILE;
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "DAMAR", "profile", "core-settings.json");
}

/** Werkudara's per-Pandawa assignment from the Core settings file, or null. */
function readWerkudaraAssignment(settingsFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
        const ref = parsed && parsed.pandawa && parsed.pandawa.models ? parsed.pandawa.models.werkudara : null;
        if (typeof ref !== "string" || !MODEL_REF.test(ref)) return null;
        const i = ref.indexOf("/");
        return { ref, connection: ref.slice(0, i), model: ref.slice(i + 1) };
    } catch { return null; }
}

/**
 * THE named resolver for the patrol's model. Returns:
 *   { model, modelSource: 'pandawa'|'daemon', provider, assignmentRef,
 *     endpoint: { baseUrl, apiKey } | null, unavailableReason }
 * `endpoint` is the daemon's configured OpenAI-compatible transport; it is
 * null when the daemon's provider selection is not a dispatchable remote
 * endpoint (e.g. the local GGUF selection), in which case an assignment
 * alone cannot be dispatched from the daemon either.
 */
function resolveWerkudaraPatrolModel({ providerConfig, settingsFile, env = process.env } = {}) {
    const cfg = providerConfig || require("../services/providerConfigService");
    const file = settingsFile || defaultCoreSettingsFile(env);
    let resolved = null;
    try { resolved = cfg.resolveActive(); } catch { resolved = null; }
    const endpoint = resolved && resolved.kind === "openai" && resolved.baseUrl && resolved.apiKey
        ? { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey } : null;
    const assignment = readWerkudaraAssignment(file);
    if (assignment) {
        return { model: assignment.model, modelSource: "pandawa", provider: assignment.connection, assignmentRef: assignment.ref,
            endpoint, unavailableReason: endpoint ? null : "ENDPOINT_DAEMON_TIDAK_TERSEDIA" };
    }
    if (endpoint && resolved.model) {
        return { model: resolved.model, modelSource: "daemon", provider: resolved.id, assignmentRef: null,
            endpoint, unavailableReason: null };
    }
    return { model: null, modelSource: null, provider: null, assignmentRef: null, endpoint,
        unavailableReason: resolved && resolved.kind === "llamacpp" ? "DAEMON_PROVIDER_LOKAL" : "DAEMON_PROVIDER_TIDAK_LENGKAP" };
}

const SYSTEM_PROMPT = [
    "Kamu Werkudara, agen pertahanan siber Damar. Tugasmu menilai bukti patroli keamanan dari komputer pemilik dan menyimpulkan kondisinya.",
    "Jawab HANYA dengan JSON valid tanpa teks lain, dengan bentuk persis: {\"summary\": string, \"findings\": [{\"severity\": \"TINGGI\"|\"SEDANG\"|\"RENDAH\"|\"INFO\", \"text\": string}]}",
    "summary: satu atau dua kalimat Bahasa Indonesia, maksimal 280 karakter, menyebut kondisi terpenting dari bukti.",
    "findings: maksimal 8 butir, urut dari risiko tertinggi. Tiap text maksimal 200 karakter, Bahasa Indonesia.",
    "Panduan severity: port berisiko (debug jarak jauh, VNC, Remote Desktop, Telnet, FTP, SMB, RPC) yang mendengarkan terbuka ke jaringan itu TINGGI; listener lain yang terbuka ke jaringan itu SEDANG; port berisiko yang hanya aktif di loopback itu RENDAH; ruang disk atau memori bebas di bawah 10 persen itu SEDANG; sisanya INFO.",
    "Jangan mengarang fakta di luar bukti yang diberikan. Bila kondisi normal, findings cukup satu butir INFO yang menyatakannya."
].join("\n");

function cleanText(v, n) {
    return String(v == null ? "" : v).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
}

/** Parse + normalize one model reply into { summary, findings }. Throws on any invalid shape. */
function parseAssessment(content) {
    const raw = String(content || "");
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("LLM_OUTPUT_TIDAK_VALID");
    let parsed;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error("LLM_OUTPUT_TIDAK_VALID"); }
    const summary = cleanText(parsed && parsed.summary, 300);
    if (!summary) throw new Error("LLM_OUTPUT_TIDAK_VALID");
    const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).map(f => ({
        severity: SEVERITIES.has(f && f.severity) ? f.severity : "INFO",
        text: cleanText(f && f.text, 220)
    })).filter(f => f.text).sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)).slice(0, 8);
    return { summary, findings };
}

/**
 * One LLM patrol assessment: the model judges the gathered evidence.
 * `target` is a resolveWerkudaraPatrolModel() result with an endpoint.
 * Returns { summary, findings }; throws with a short coded reason on any
 * failure (transport, HTTP status, empty or invalid output).
 */
async function assessPatrolWithLlm({ kind, evidence, target, fetchImpl, timeoutMs = 120_000 } = {}) {
    if (!target || !target.endpoint || !target.model) throw new Error("LLM_TARGET_TIDAK_TERSEDIA");
    const transport = typeof fetchImpl === "function" ? fetchImpl : ((...a) => fetch(...a));
    const url = String(target.endpoint.baseUrl).replace(/\/+$/, "") + "/chat/completions";
    let response;
    try {
        response = await transport(url, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
            headers: { "content-type": "application/json", authorization: "Bearer " + target.endpoint.apiKey },
            body: JSON.stringify({
                model: target.model,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: `Jenis patroli: ${kind === "sistem" ? "SISTEM" : "JARINGAN"}\nBukti yang dikumpulkan dari host (JSON):\n${JSON.stringify(evidence || {}).slice(0, 6000)}` }
                ],
                temperature: 0.2, max_tokens: 800, stream: false
            })
        });
    } catch (err) {
        throw new Error(err && err.name === "TimeoutError" ? "LLM_TIMEOUT" : "LLM_TIDAK_TERJANGKAU");
    }
    if (!response || !response.ok) throw new Error("LLM_HTTP_" + (response ? response.status : "TIDAK_ADA_RESPON"));
    let body = null;
    try { body = await response.json(); } catch { throw new Error("LLM_OUTPUT_TIDAK_VALID"); }
    const content = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : null;
    if (!content) throw new Error("LLM_OUTPUT_KOSONG");
    return parseAssessment(content);
}

/** Composition seam: the patrol loop's `llm` dependency. */
function createPatrolLlm({ providerConfig, settingsFile, env = process.env, fetchImpl, timeoutMs } = {}) {
    return {
        resolveTarget: () => resolveWerkudaraPatrolModel({ providerConfig, settingsFile, env }),
        assess: ({ kind, evidence, target }) => assessPatrolWithLlm({ kind, evidence, target, fetchImpl, timeoutMs })
    };
}

module.exports = { createPatrolLlm, resolveWerkudaraPatrolModel, readWerkudaraAssignment, defaultCoreSettingsFile, assessPatrolWithLlm, parseAssessment, MODEL_REF };
