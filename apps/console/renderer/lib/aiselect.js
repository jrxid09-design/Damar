import { api } from "./api.js";
import { icon } from "./icons.js";
import { toast } from "./ui.js";

/**
 * Selektor "AI Lokal / AI Provider" yang dipakai bersama oleh
 * beberapa view (Chat, Models). Menyembunyikan detail id provider:
 * pengguna cukup memilih otak Damar antara lokal (Ollama) atau
 * cloud (provider ber-API-key).
 *
 * Mengubah pilihan = mengganti provider AKTIF daemon (bukan cuma
 * tampilan), lewat POST /ai/config { active }.
 */
export const aiChoices = {

    /**
     * Isi elemen `.seg` dengan dua tombol pilihan lalu pasang
     * handler. `onChange()` dipanggil setelah provider berhasil
     * diganti — dipakai pemanggil untuk memuat ulang daftar model.
     */
    async render(segEl, onChange) {

        let cfg;
        try {
            cfg = await api.request("/ai/config");
        }
        catch (error) {
            segEl.innerHTML = `<span class="small danger-text">AI: ${error.message}</span>`;
            return;
        }

        const providerIds = Object.keys(cfg.providers);

        // Provider cloud yang dipakai: yang aktif bila cloud, kalau
        // tidak ambil yang sudah punya key, kalau tidak yang pertama.
        const cloudId = cfg.active !== "ollama"
            ? cfg.active
            : (providerIds.find(id => cfg.providers[id].hasKey) ?? providerIds[0]);

        const cloud = cfg.providers[cloudId];
        const cloudReady = Boolean(cloud?.hasKey);
        const isLocal = cfg.active === "ollama";

        segEl.innerHTML = `
            <button type="button" data-ai="ollama" class="${isLocal ? "active" : ""}">
                ${icon("server")} AI Lokal</button>
            <button type="button" data-ai="${cloudId}" class="${isLocal ? "" : "active"}"
                title="${cloudReady ? "" : "Belum ada API key — atur di Settings"}">
                ${icon("cloud")} AI Provider${cloud ? ` · ${cloud.label}` : ""}</button>`;

        const buttons = segEl.querySelectorAll("[data-ai]");

        buttons.forEach(button => {

            button.addEventListener("click", async () => {

                const id = button.dataset.ai;

                if (id !== "ollama" && !cloudReady) {
                    toast("Belum ada API key. Buka Settings → Provider AI dulu.", "warn", 5000);
                    return;
                }

                if (button.classList.contains("active")) {
                    return;
                }

                try {
                    await api.request("/ai/config", { method: "POST", body: { active: id } });
                    buttons.forEach(b => b.classList.toggle("active", b === button));
                    await onChange?.();
                }
                catch (error) {
                    toast(error.message, "danger", 5000);
                }

            });

        });

    }

};
