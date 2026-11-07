const fs = require("node:fs");
const path = require("node:path");

/**
 * AUTHORITY LINT — pemeriksa struktural atas permukaan otoritas.
 *
 * M1/CLOSURE — STATUS: DEFENSE-IN-DEPTH SAJA.
 *
 * Lint ini adalah heuristik teks dan TERBUKTI BISA DIKABURI (string
 * terpecah, alias modul, bentuk dinamis). Ia BUKAN penghalang
 * otoritas dan TIDAK PERNAH diklaim demikian. Penghalang otoritas
 * yang sebenarnya adalah penegakan STRUKTURAL saat runtime:
 *   - Authorization.assertExecution pada SETIAP gerbang eksekusi
 *     (ToolExecutor, ToolBus) — dipanggil SEBELUM validasi argumen;
 *   - identitas kanonik tunggal (requestIdentity/AIRuntime) sehingga
 *     role literal tanpa titik kanonik tidak menghasilkan wewenang;
 *   - resolveDelegator sebagai satu-satunya pencipta grant internal
 *     ber-token symbol.
 *
 * Mendeteksi DUA kelas pelanggaran (bukan sekadar regex tambahan):
 *
 *   R1 — literal peran eksekusi privileged ("system"/"admin"/
 *        "superadmin"), termasuk lewat variabel (camelCase pun) dan
 *        ekspresi terkomputasi (`role: cond ? "system" : "user"`),
 *        di luar titik kanonik. Objek PESAN chat ({role, content})
 *        bukan identitas — dikecualikan.
 *
 *   R3 — KEHILANGAN RESTRIKSI DI TRANSIT: panggilan chat()/stream()
 *        dalam berkas berkaitan-exec wajib membawa bukti restriction:
 *        kunci capabilitySet, helper turnRestrictions(), penerusan
 *        request utuh (...request), ATAU identitas kanonik utuh
 *        (`exec`). Inilah kelas bug watchdog: grant kanonik membawa
 *        set, tetapi hop agentHub→aiRuntime menjatuhkannya.
 *
 * Situs yang dikecualikan WAJIB terdaftar eksplisit di ALLOWLIST
 * dengan alasannya — bukan pengecualian diam-diam.
 */

const PRIV = "(system|superadmin|admin)";

/** Situs tersanksi: { file, reason, pattern } — pola dicocokkan ke teks temuan. */
const ALLOWLIST = [
    {
        file: path.join("ai", "tools", "Authorization.js"),
        pattern: /role\s*:\s*ROLE_RANK\b/,
        reason:
            "Titik KANONIK normalisasi identitas: peran asing DILUCUTI " +
            "ke 'user' (fail-closed), bukan dinaikkan. Ini pelucutan, " +
            "bukan pembentukan otoritas."
    },
    {
        file: path.join("services", "telegramService.js"),
        pattern: /inFullMode\(chatId\)\s*\?\s*"superadmin"/,
        reason:
            "Mode penuh Telegram naik ke superadmin HANYA setelah verifikasi " +
            "TOTP (/masuk) — mekanisme eskalasi yang disengaja dan tercatat."
    }
];

function stripComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function enclosingObject(code, idx) {
    let depth = 0, start = -1;
    for (let i = idx; i >= 0; i--) {
        if (code[i] === "}") depth++;
        else if (code[i] === "{") {
            if (depth === 0) { start = i; break; }
            depth--;
        }
    }
    if (start < 0) return "";
    depth = 0;
    for (let i = start; i < code.length; i++) {
        if (code[i] === "{") depth++;
        else if (code[i] === "}") { depth--; if (depth === 0) return code.slice(start, i + 1); }
    }
    return "";
}

/** Span objek literal pertama setelah posisi `(` dari sebuah panggilan. */
function callObjectSpan(code, callStart) {
    const open = code.indexOf("{", callStart);
    if (open < 0) return null;
    let depth = 0;
    let inStr = null;
    for (let i = open; i < code.length; i++) {
        const ch = code[i];
        if (inStr) {
            if (ch === "\\") i++;
            else if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === "\"" || ch === "'" || ch === "`") { inStr = ch; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return code.slice(open, i + 1);
        }
    }
    return null;
}

function allowed(rel, snippet) {
    return ALLOWLIST.some(a =>
        rel.endsWith(a.file) && a.pattern.test(snippet));
}

/**
 * Pindai satu berkas (kode mentah). Kembalikan daftar pelanggaran.
 * @param {string} raw  isi berkas
 * @param {string} rel  jalur relatif thd src/ (untuk allowlist)
 */
function scanSource(raw, rel = "") {

    const code = stripComments(raw);
    const violations = [];

    // ---- R0: internalGrant hanya lahir di titik kanonik ----------------
    if (!rel.endsWith(path.join("ai", "tools", "Authorization.js"))) {
        const reGrant = /internalGrant\s*:\s*true/g;
        let g;
        while ((g = reGrant.exec(code)) !== null) {
            violations.push(
                `${rel}: internalGrant literal (harus lewat Authorization.resolveDelegator)`);
        }
    }

    // ---- R1: literal peran eksekusi pada objek non-pesan -------------
    const reLiteral = new RegExp(
        `\\brole\\s*[:=]\\s*["']${PRIV}["']`, "g");
    // ---- R1b: peran terkomputasi (ekspresi apa pun menyentuh literal)
    const reComputed = new RegExp(
        `\\brole\\s*:\\s*[^,\\n]*["']${PRIV}["']`, "g");

    const seenPos = new Set();

    for (const re of [reLiteral, reComputed]) {
        let m;
        while ((m = re.exec(code)) !== null) {
            const obj = enclosingObject(code, m.index);
            if (/\bcontent\b/.test(obj)) continue;          // pesan chat
            if (seenPos.has(m.index)) continue;
            seenPos.add(m.index);
            const text = m[0].trim();
            if (!allowed(rel, text)) {
                violations.push(`${rel}: ${text}`);
            }
        }
    }

    // ---- R2: variabel pembawa otoritas --------------------------------
    // Deklarasi <nama>Role*/roleX* = literal privileged, lalu dipakai
    // sebagai nilai role:. Menangkap camelCase (`systemRole`, `RoleOfX`)
    // dan penyimpanan antara.
    const reDecl = new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*["']${PRIV}["']`,
        "g");
    const carriers = [];
    let d;
    while ((d = reDecl.exec(code)) !== null) {
        const name = d[1];
        if (!/role/i.test(name)) continue;                  // bukan carrier peran
        const declObj = enclosingObject(code, d.index);
        if (/\bcontent\b/.test(declObj)) continue;          // pesan chat
        carriers.push({ name, at: d.index });
    }

    for (const c of carriers) {
        const reUse = new RegExp(`\\brole\\s*:\\s*[\\w$().!]*\\b${c.name}\\b`, "g");
        let u;
        while ((u = reUse.exec(code)) !== null) {
            const obj = enclosingObject(code, u.index);
            if (/\bcontent\b/.test(obj)) continue;
            if (allowed(rel, u[0])) continue;
            violations.push(
                `${rel}: role via variabel '${c.name}' (= peran privileged)`);
            break;                                          // satu temuan per carrier cukup
        }
    }

    // ---- R3: chat/stream tanpa bukti capabilitySet ---------------------
    // \bexec\b di sini berarti konteks delegasi — BUKAN Regex.exec().
    const fileCarriesExec =
        /\bexec\b/.test(code.replace(/\.\s*exec\s*\(/g, ".EXEC_CALL("));

    if (fileCarriesExec) {

        const reCall = /\.(?:chat|stream)\s*\(\s*\{/g;
        let c;

        while ((c = reCall.exec(code)) !== null) {

            const obj = callObjectSpan(code, c.index + c[0].lastIndexOf("("));

            if (!obj) continue;

            // Bukti restriction ikut: kunci capabilitySet langsung,
            // helper restriction proyek, penerusan request utuh
            // (request.exec adalah identitas kanonik yang sudah memuat set),
            // ATAU identitas kanonik utuh `exec` menyeberang sebagai
            // SATU objek ({ exec } shorthand / { exec: <var> }).
            // Penggunaan TERPISAH field exec (exec?.sessionId,
            // delegatedRoleOf(exec)) BUKAN bukti — persis bentuk bug
            // watchdog yang wajib tertangkap.
            const carries =
                /\bcapabilitySet\b/.test(obj) ||
                /\bturnRestrictions\s*\(/.test(obj) ||
                /\.\.\.request\b/.test(obj) ||
                /[{,]\s*exec\s*[,}]/.test(obj) ||
                /[{,]\s*exec\s*:\s*[A-Za-z_$][\w$]*\s*[,}]/.test(obj);

            if (carries) continue;
            if (allowed(rel, obj)) continue;

            violations.push(
                `${rel}: chat/stream dalam berkas berkaitan-exec tidak ` +
                `membawa capabilitySet — potensi pelucutan restriction`
            );
        }

    }

    return violations;

}

/** Pindai seluruh berkas .js di bawah src (rekursif). */
function scanTree(srcDir) {

    function* jsFiles(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) yield* jsFiles(p);
            else if (entry.name.endsWith(".js")) yield p;
        }
    }

    const all = [];
    for (const file of jsFiles(srcDir)) {
        const rel = path.relative(srcDir, file);
        try {
            all.push(...scanSource(fs.readFileSync(file, "utf8"), rel));
        }
        catch { /* berkas tak terbaca: lewati */ }
    }
    return all;

}

module.exports = { scanSource, scanTree, stripComments, enclosingObject, ALLOWLIST };
