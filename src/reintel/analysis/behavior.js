/**
 * RE Intelligence — pemetaan evidence → klaim capability perilaku.
 *
 * Klaim perilaku statis selalu berbentuk KEMAMPUAN/KE MUNGKINAN
 * ("MAY_*"), tidak pernah pengamatan eksekusi. Analisis statis tidak
 * bisa membuktikan bahwa sesuatu DIJALANKAN — hanya bahwa mekanisme
 * untuk melakukannya ADA di artifact.
 *
 * Invarian: setiap klaim wajib membawa ID bukti pendukung; tanpa bukti
 * → klaim ditolak (dilempar). Tidak ada "kepastian perilaku".
 */

"use strict";

const { BehavioralClaimType, freezeDeep } = require("../model/model");

/** kategori bukti skrip / sinyal import DLL → tipe klaim. */
const SCRIPT_CATEGORY_MAP = Object.freeze({
    network_api: BehavioralClaimType.MAY_ACCESS_NETWORK,
    url_reference: BehavioralClaimType.MAY_ACCESS_NETWORK,
    subprocess: BehavioralClaimType.MAY_CREATE_PROCESS,
    filesystem_write: BehavioralClaimType.MAY_MODIFY_FILES,
    registry_access: BehavioralClaimType.MAY_ACCESS_REGISTRY,
    crypto_use: BehavioralClaimType.MAY_PERFORM_CRYPTOGRAPHY
});

const IMPORT_DLL_MAP = [
    { re: /\b(winhttp|wininet|ws2_32|wsock32)\.dll$/i, claim: BehavioralClaimType.MAY_ACCESS_NETWORK },
    { re: /\badvapi32\.dll$/i, claim: BehavioralClaimType.MAY_ACCESS_REGISTRY },
    { re: /\bbcrypt\.dll$|\bcrypt32\.dll$|\bncrypt\.dll$/i, claim: BehavioralClaimType.MAY_PERFORM_CRYPTOGRAPHY }
];

const IMPORT_FUNCTION_MAP = [
    { re: /^(CreateProcess|ShellExecute|WinExec)/i, claim: BehavioralClaimType.MAY_CREATE_PROCESS },
    { re: /^(WriteFile|DeleteFile|MoveFile|CopyFile|SetFileAttributes|RegSetValue)/i,
        claim: BehavioralClaimType.MAY_MODIFY_FILES },
    { re: /^LoadLibrary/i, claim: BehavioralClaimType.MAY_LOAD_DYNAMIC_LIBRARY },
    { re: /^(InternetOpen|HttpSendRequest|WinHttpOpen|connect|send|socket)$/i,
        claim: BehavioralClaimType.MAY_ACCESS_NETWORK }
];

/**
 * Derive klaim dari sekumpulan evidence.
 * @param {Array} evidence - item dengan { id, kind, observation }.
 */
function deriveBehavioralClaims(evidence) {
    const byClaim = new Map();

    const add = (claim, evId, observation) => {
        if (!byClaim.has(claim)) {
            byClaim.set(claim, { claim, basis: [] });
        }
        const entry = byClaim.get(claim);
        entry.basis.push({ evidenceId: evId });
        entry._observations ??= [];
        entry._observations.push(observation);
    };

    for (const e of evidence) {
        // Sinyal pola skrip.
        const m = /^(\w+):\s/.exec(e.observation);
        if (m && e.kind === "script_pattern") {
            const claim = SCRIPT_CATEGORY_MAP[m[1]];
            if (claim) add(claim, e.id, e.observation);
            continue;
        }
        // Sinyal tabel import PE: "imports KERNEL32.dll: CreateFileW, ..."
        if (e.kind === "import_table") {
            const im = /^imports\s+(\S+?):\s*(.*)$/.exec(e.observation);
            if (!im) continue;
            const dll = im[1];
            for (const rule of IMPORT_DLL_MAP) {
                if (rule.re.test(dll)) add(rule.claim, e.id, e.observation);
            }
            const functions = im[2].split(", ").filter(Boolean);
            for (const fn of functions) {
                for (const rule of IMPORT_FUNCTION_MAP) {
                    if (rule.re.test(fn)) add(rule.claim, e.id, `${dll}:${fn}`);
                }
            }
        }
    }

    const claims = [];
    for (const [claim, entry] of byClaim) {
        claims.push(freezeDeep({
            type: claim,
            /** Statis = kemungkinan, BUKAN observasi eksekusi. */
            certainty: "possible",
            derivedFrom: freezeDeep(entry.basis),
            note: `didukung ${entry.basis.length} bukti statis; bukan pengamatan eksekusi`
        }));
    }

    return freezeDeep(claims);
}

module.exports = { deriveBehavioralClaims };
