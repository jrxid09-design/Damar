// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchAudioConsoleTool {

    constructor() {
        this.name = "patchAudioConsole";
        this.description = "Menambahkan dukungan pemutaran audio (kind:\"audio\") di Console Aether: (1) patch renderer app.js agar menerima kind audio & menampilkan <audio controls>, (2) patch daemon mediaTools.js dengan tool show_audio yang mengonversi file audio lokal ke data:base64 dan publish event aether:present kind audio.";
        this.parameters = {
                "appPath": {
                        "type": "string",
                        "description": "Path renderer app.js (default dari env)",
                        "required": false
                },
                "mediaPath": {
                        "type": "string",
                        "description": "Path daemon mediaTools.js (default dari env)",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require("fs");
        const path = require("path");

        // Path default
        const appPath = args.appPath || process.env.AETHER_CONSOLE_APP_JS || "C:\\Workspace\\Aether\\apps\\console\\renderer\\app.js";
        const mediaPath = args.mediaPath || process.env.AETHER_MEDIATOOLS_JS || "C:\\Users\\jrxid\\AppData\\Roaming\\npm\\node_modules\\aether\\src\\services\\mediaTools.js";

        const report = { app: null, media: null, errors: [] };

        // ---- PATCH 1: renderer app.js ----
        try {
          let src = fs.readFileSync(appPath, "utf8");
          let changed = false;

          // 1a. Tambahkan "audio" ke whitelist kind di presentMedia
          const oldWhitelist = 'if (!["image", "video", "document"].includes(p.kind)) return;';
          const newWhitelist = 'if (!["image", "video", "document", "audio"].includes(p.kind)) return;';
          if (src.includes(oldWhitelist)) {
            src = src.replace(oldWhitelist, newWhitelist);
            changed = true;
          } else if (!src.includes('"audio"]')) {
            report.errors.push("Whitelist audio tidak ditemukan (pola berubah)");
          }

          // 1b. Tambahkan kasus render <audio> setelah kasus document di openPresentPanel
          const docCase = 'else if (p.kind === "document")';
          const audioCase = 'else if (p.kind === "audio") {\n        body = p.url\n            ? `<audio src="${esc(p.url)}" controls autoplay playsinline style="width:100%;max-width:520px"></audio>`\n            : `<div style="padding:40px;color:var(--warn)">Audio tidak tersedia</div>`;\n    }';
          if (src.includes(docCase) && !src.includes('p.kind === "audio"')) {
            src = src.replace(docCase, audioCase + "\n    " + docCase);
            changed = true;
          } else if (!src.includes('p.kind === "audio"')) {
            report.errors.push("Kasus document tidak ditemukan untuk menyisipkan audio");
          }

          if (changed) {
            fs.writeFileSync(appPath, src, "utf8");
            report.app = { patched: true };
          } else {
            report.app = { patched: false, note: "Tidak ada perubahan diperlukan / sudah terpatch" };
          }
        } catch (e) {
          report.errors.push("app.js: " + String(e).slice(0, 200));
        }

        // ---- PATCH 2: daemon mediaTools.js ----
        try {
          let src = fs.readFileSync(mediaPath, "utf8");
          let changed = false;

          const toolName = "show_audio";
          if (!src.includes('name: "' + toolName + '"')) {
            // Sisipkan tool show_audio sebelum show_video
            const anchor = 'name: "show_video"';
            const newTool = `new AITool({
                    name: "show_audio",
                    description:
                        "Tampilkan/memutar sebuah file audio (mp3/wav/ogg/m4a) ke pengguna di Console. " +
                        "Mengonversi path file lokal / file:// ke data URI audio base64 agar webview Console " +
                        "bisa memutarnya. Pakai saat pengguna minta memutar/memperdengarkan audio.",
                    parameters: {
                        type: "object",
                        properties: {
                            url: { type: "string", description: "Path file audio lokal atau file:// URL." },
                            caption: { type: "string", description: "Keterangan singkat." }
                        },
                        required: ["url"]
                    },
                    execute: async ({ url, caption }) => {
                        const fs = require("fs");
                        let displayUrl = url;
                        try {
                            let p = null;
                            if (url.startsWith("file://")) p = decodeURI(url.replace(/^file:\\/\\/?/, ""));
                            else if (/^[A-Za-z]:[\\\\/]/.test(url) || url.startsWith("\\\\\\\\")) p = url;
                            if (p) {
                                const buf = fs.readFileSync(p);
                                const ext = (p.split(".").pop() || "").toLowerCase();
                                const mime = ({ mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" })[ext] || "audio/mpeg";
                                displayUrl = "data:" + mime + ";base64," + buf.toString("base64");
                            }
                        } catch (e) {
                            console.error("[aether] show_audio: konversi lokal gagal:", String(e).slice(0, 200));
                        }
                        telemetry.publish("aether:present", {
                            kind: "audio", url: displayUrl, caption: caption ?? null
                        });
                        return { ok: true, shown: "audio", url: displayUrl, converted: displayUrl !== url };
                    }
                }),

                `;
            if (src.includes(anchor)) {
              src = src.replace(anchor, newTool + anchor);
              changed = true;
            } else {
              report.errors.push("Anchor show_video tidak ditemukan di mediaTools.js");
            }
          } else {
            report.app = report.app || {};
            report.media = { patched: false, note: "show_audio sudah ada" };
          }

          if (changed) {
            fs.writeFileSync(mediaPath, src, "utf8");
            report.media = { patched: true };
          }
        } catch (e) {
          report.errors.push("mediaTools.js: " + String(e).slice(0, 200));
        }

        // Verifikasi sintaks kedua file dengan node --check
        const { execSync } = require("child_process");
        for (const [label, p] of [["app.js", appPath], ["mediaTools.js", mediaPath]]) {
          try {
            execSync(`node --check "${p}" 2>&1`, { shell: "cmd.exe" });
            report[label] = report[label] || {};
            report[label].syntax = "OK";
          } catch (e) {
            report[label] = report[label] || {};
            report[label].syntax = "FAIL: " + String(e.stderr || e).slice(0, 200);
            report.errors.push(label + " syntax fail");
          }
        }

        return { ok: report.errors.length === 0, report };

    }

}

module.exports = [ new PatchAudioConsoleTool() ];
