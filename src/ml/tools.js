const { AITool } = require("../ai/tools");
const { executeCanonicalAction, contextFromExecution } = require("../services/canonicalActionClient");
const ML = "damar.ml";

/**
 * Tool AI/ML — Damar sebagai peneliti & insinyur ML.
 *
 * Sengaja SATU tool bukti (ml_env): eksperimen dijalankan lewat jalur
 * eksekusi yang sudah ada (terminal_run untuk Python, kali_run untuk
 * Linux). Yang model tak boleh tebak adalah HARDWARE & FRAMEWORK nyata
 * — itu yang disediakan di sini agar klaim "training di GPU" berpijak
 * pada pemeriksaan, bukan angan.
 */
function mlTools() {

    return [

        new AITool({
            name: "ml_env",
            description:
                "PERIKSA lingkungan ML/AI nyata: versi Python, framework terpasang (torch, " +
                "tensorflow, jax, transformers, sklearn, numpy, pandas, dll.) beserta versinya, " +
                "kesiapan CUDA (torch.cuda), dan GPU tingkat OS (nvidia-smi). Panggil SEBELUM " +
                "merancang eksperimen, memilih ukuran model/batch, atau menjanjikan pelatihan " +
                "di GPU — jangan pernah mengarang ketersediaan GPU/CUDA. Bila Python belum ada, " +
                "hasilnya berkata apa adanya (bukan 'torch tidak terpasang').",
            parameters: { type: "object", properties: {} },
            execute: async (_, execution) => executeCanonicalAction({ context: contextFromExecution(execution), capabilityId: ML, operation: "probe", arguments: {}, expectedPostcondition: { expect: { completed: { op: "eq", value: true } } } })
        }),

        new AITool({
            name: "ml_run",
            description:
                "JALANKAN kode/skrip Python di lingkungan ML nyata (interpreter yang sama " +
                "dengan ml_env) — untuk eksperimen, training, evaluasi, ablation, atau " +
                "pemeriksaan cepat (bentuk tensor, versi, metrik). Beri `code` (potongan) " +
                "ATAU `file` (path skrip). Balikan { ok, code, seconds, stdout, stderr } apa " +
                "adanya; exit ≠ 0 & stack trace DIKEMBALIKAN sebagai data, bukan disembunyikan. " +
                "Panggil ml_env dulu bila belum tahu framework/GPU yang tersedia.",
            parameters: {
                type: "object",
                properties: {
                    code: { type: "string", description: "Potongan Python untuk dijalankan (mis. eksperimen kecil / cek versi)." },
                    file: { type: "string", description: "Path skrip .py yang dijalankan (alternatif dari code)." },
                    cwd: { type: "string", description: "Direktori kerja (opsional)." },
                    timeout: { type: "number", description: "Batas waktu ms (default 600000 = 10 menit)." }
                }
            },
            execute: async ({ code, file, cwd, timeout }, execution) => executeCanonicalAction({ context: contextFromExecution(execution), capabilityId: ML, operation: "run", arguments: { code, file, cwd, timeout }, expectedPostcondition: { expect: { operation: { op: "eq", value: "run" }, parametersMatch: { op: "eq", value: true }, completed: { op: "eq", value: true } } } })
        })

    ];

}

module.exports = { mlTools };
