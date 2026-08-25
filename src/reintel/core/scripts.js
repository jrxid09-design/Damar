/**
 * RE Intelligence — analisis statis skrip/teks.
 *
 * Menurunkan HINT bahasa dan pola-pola menarik (import, subprocess,
 * jaringan, filesystem, registry, kripto, URL). Setiap match adalah
 * EVIDENCE — bukan kesimpulan. Kehadiran API tidak membuktikan
 * perilaku berbahaya; pemetaan ke klaim capability dilakukan di
 * analysis/behavior.js dengan tingkat "possible".
 */

"use strict";

const { EvidenceKind, freezeDeep } = require("../model/model");

const SHEBANG_LANGS = [
    { re: /^#!.*\bpython/, lang: "python" },
    { re: /^#!.*\bnode\b/, lang: "javascript" },
    { re: /^#!.*\b(bash|sh|dash|zsh)\b/, lang: "shell" },
    { re: /^#!.*\bruby/, lang: "ruby" },
    { re: /^#!.*\bperl/, lang: "perl" },
    { re: /^#!.*\bpwsh|powershell/, lang: "powershell" }
];

const EXT_LANGS = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript",
    ".py": "python", ".rb": "ruby", ".pl": "perl",
    ".sh": "shell", ".bash": "shell",
    ".ps1": "powershell", ".bat": "batch", ".cmd": "batch",
    ".php": "php", ".lua": "lua"
};

const PATTERN_CATEGORIES = [
    {
        category: "script_import",
        re: /\brequire\s*\(|\bimport\s+.+\s+from\s+|#include\s*[<"]|\buse\s+\w+::|\bfrom\s+[\w.]+\s+import\b/g
    },
    {
        category: "subprocess",
        re: /\bchild_process\b|\bexecSync?\b|\bspawn(Sync)?\b|\bsubprocess\b|\bos\.system\b|\bpopen\b|\bStart-Process\b|\bsystem\s*\(/g
    },
    {
        category: "network_api",
        re: /\bfetch\s*\(|\bhttp\.request\b|\baxios\b|\brequests\.(get|post)\b|\burllib\b|\bInvoke-WebRequest\b|\bwinhttp\b|\bWebSocket\b|\bcurl\s|\bwget\b|\bnet\.Socket\b/g
    },
    {
        category: "filesystem_write",
        re: /\bfs\.(writeFile|appendFile|unlink|rmdir|mkdir|rm)\w*\b|\bWriteAllText\b|\bSet-Content\b|\bfile_put_contents\b|\bopen\s*\([^)]*['"][wa]\+/g
    },
    {
        category: "registry_access",
        re: /\bReg(OpenKey|SetValue|CreateKey|DeleteKey)\w*\b|\bHKLM\b|\bHKCU\b|\bwinreg\b/g
    },
    {
        category: "crypto_use",
        re: /\bcrypt(?:o|ography)?\b|\bAES\b|\bRSA\b|\bhashlib\b|\bCryptAcquireContext\b|\bcreateCipheriv\b|\bgpg\b/g
    }
];

const URL_RE = /https?:\/\/[^\s"'<>()]+/g;

/**
 * Analisis teks (maks maxScanBytes) → { languageHint, evidence }.
 * Deterministik; jumlah match per kategori dibatasi config.
 */
function analyzeScript(buffer, limits) {
    const scanLen = Math.min(buffer.length, 1024 * 1024);
    const text = buffer.toString("utf8", 0, scanLen);
    const lines = text.split(/\r?\n/);

    const evidence = [];
    let seq = 0;
    const pushEvidence = (kind, observation, location) => {
        const item = {
            id: `sev-${String(++seq).padStart(4, "0")}`,
            source: "script_analysis",
            kind,
            observation,
            ...(location ? { location: freezeDeep(location) } : {})
        };
        evidence.push(freezeDeep(item));
        return item;
    };

    // ---- hint bahasa ----------------------------------------------------
    let languageHint = null;
    const first = lines[0] ?? "";
    for (const s of SHEBANG_LANGS) {
        if (s.re.test(first)) { languageHint = s.lang; break; }
    }

    // ---- pola per baris ---------------------------------------------------
    const categoryHits = new Map();
    const maxPerCat = limits.maxScriptMatchesPerCategory;

    outer:
    for (let li = 0; li < lines.length && li <= 100000; li++) {
        const line = lines[li];

        if (languageHint === null) {
            for (const s of SHEBANG_LANGS) {
                if (li === 0 && s.re.test(line)) { languageHint = s.lang; break; }
            }
        }

        for (const cat of PATTERN_CATEGORIES) {
            cat.re.lastIndex = 0;
            let m;
            let hits = categoryHits.get(cat.category) ?? [];
            while ((m = cat.re.exec(line)) !== null) {
                if (hits.length >= maxPerCat) break;
                hits.push({ line: li + 1, match: m[0].slice(0, limits.maxEvidenceLiteralChars) });
            }
            if (hits.length) categoryHits.set(cat.category, hits);
        }

        // URL — kategori sendiri tanpa regex global yang di-reset aneh.
        URL_RE.lastIndex = 0;
        let u;
        let urlHits = categoryHits.get("url_reference") ?? [];
        while ((u = URL_RE.exec(line)) !== null) {
            if (urlHits.length >= maxPerCat) break;
            urlHits.push({ line: li + 1, match: u[0].slice(0, limits.maxEvidenceLiteralChars) });
        }
        if (urlHits.length) categoryHits.set("url_reference", urlHits);
    }

    for (const [category, hits] of categoryHits) {
        pushEvidence(
            EvidenceKind.SCRIPT_PATTERN,
            `${category}: ${hits.map((h) => h.match).join(", ")}`,
            { lines: hits.slice(0, 5).map((h) => h.line) }
        );
    }

    return freezeDeep({
        languageHint,
        evidence,
        scannedChars: scanLen,
        truncated: scanLen < buffer.length
    });
}

module.exports = { analyzeScript };
