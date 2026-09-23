const { AITool } = require("../ai/tools");
const auditor = require("./auditor");
const { executeCanonicalAction, contextFromExecution } = require("../services/canonicalActionClient");

/**
 * Tool insinyur keamanan — audit BERBASIS BUKTI pada aset milik pemilik.
 *
 * Tiga sudut yang saling melengkapi: rahasia yang bocor ke repo,
 * dependensi berkerentanan diketahui, dan pola kode berbahaya. Semua
 * membaca berkas lokal (dan `npm audit`) — tak satu pun menyentuh
 * sistem pihak ketiga.
 */
function securityTools() {

    return [

        new AITool({
            name: "sec_secret_scan",
            description:
                "PINDAI rahasia yang bocor ke dalam repo (private key, kunci API, token, " +
                "password ter-hardcode) di seluruh berkas terlacak. Jalankan sebelum " +
                "mempublikasikan repo, sesudah menambah integrasi baru, dan saat audit " +
                "keamanan. Temuan menunjuk berkas:baris — rahasia yang ditemukan berarti " +
                "sudah ada di riwayat git, jadi kuncinya HARUS dicabut, bukan sekadar dihapus.",
            parameters: {
                type: "object",
                properties: {
                    project: { type: "string", description: "Path root proyek (opsional; default proyek daemon)." },
                    maxTemuan: { type: "number", description: "Batas temuan yang dikembalikan (default 50)." }
                }
            },
            execute: async ({ project, maxTemuan }, execution) => executeCanonicalAction({ context: contextFromExecution(execution), capabilityId: "damar.security", operation: "scanSecrets", arguments: { project: project ?? null, maxTemuan: maxTemuan ?? 50 }, expectedPostcondition: { expect: { operation: { op: "eq", value: "scanSecrets" }, completed: { op: "eq", value: true } } } })
        }),

        new AITool({
            name: "sec_code_audit",
            description:
                "AUDIT pola kode berbahaya (SAST ringan): eksekusi dinamis (eval/new Function), " +
                "injeksi perintah & SQL, verifikasi TLS dimatikan, traversal path, kripto lemah " +
                "(MD5/SHA-1), acak tidak aman untuk token, XSS DOM, CORS terbuka. Balikan " +
                "temuan berkas:baris + cara memperbaikinya. Pakai saat diminta menilai keamanan " +
                "kode, sesudah menulis endpoint/penanganan masukan pengguna, atau saat audit.",
            parameters: {
                type: "object",
                properties: {
                    project: { type: "string", description: "Path root proyek (opsional)." },
                    files: { type: "array", items: { type: "string" }, description: "Batasi ke berkas tertentu (relatif ke proyek)." },
                    maxTemuan: { type: "number", description: "Batas temuan (default 60)." }
                }
            },
            execute: async ({ project, files, maxTemuan }, execution) => executeCanonicalAction({ context: contextFromExecution(execution), capabilityId: "damar.security", operation: "auditCode", arguments: { project: project ?? null, files: files ?? null, maxTemuan: maxTemuan ?? 60 }, expectedPostcondition: { expect: { operation: { op: "eq", value: "auditCode" }, completed: { op: "eq", value: true } } } })
        }),

        new AITool({
            name: "sec_dep_audit",
            description:
                "PERIKSA kerentanan dependensi (npm audit) — jumlah per tingkat + paket " +
                "kritis/tinggi/sedang beserta ada-tidaknya perbaikan. Bila audit tidak bisa " +
                "berjalan (offline/tanpa lockfile) hasilnya 'tidak diketahui', BUKAN 'aman' — " +
                "sampaikan apa adanya.",
            parameters: {
                type: "object",
                properties: { project: { type: "string", description: "Path root proyek (opsional)." } }
            },
            execute: async ({ project }, execution) => executeCanonicalAction({ context: contextFromExecution(execution), capabilityId: "damar.security", operation: "auditDeps", arguments: { project: project ?? null }, expectedPostcondition: { expect: { operation: { op: "eq", value: "auditDeps" }, completed: { op: "eq", value: true } } } })
        })

    ];

}

module.exports = { securityTools };
