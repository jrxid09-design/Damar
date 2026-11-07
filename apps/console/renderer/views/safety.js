import { api } from "../lib/api.js";
import { esc, toast } from "../lib/ui.js";

/**
 * Panel Keamanan — pusat kendali batas kemampuan Damar.
 *
 * Disederhanakan lagi: gerbang enam tingkat (L0–L5) lalu gerbang
 * tool destruktif sudah dihapus — guard selalu mengizinkan semua
 * eksekusi. Yang tersisa di panel ini adalah kill switch (STOP),
 * klasifikasi risiko sebagai informasi, dan jejak audit.
 *
 * Layout dirancang untuk layar lebar: kartu-kartu menyebar, bukan
 * menumpuk vertikal di tengah.
 */

let host = null;
let timer = null;
let snapshot = null;
let trail = null;

export const safety = {

    id: "safety",
    label: "Keamanan",
    icon: "shield",
    title: "Keamanan",
    subtitle: "Batas kemampuan Damar — apa yang boleh, apa yang ditahan.",

    render(root) {

        host = root;

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Keamanan</h1>
                    <p>Batas kemampuan Damar — apa yang boleh, apa yang ditahan.</p>
                </div>
                <div class="actions">
                    <button class="btn" id="sf-refresh">Segarkan</button>
                </div>
            </div>
            <div id="sf-body"><p class="dim small">Memuat…</p></div>
        `;

        root.querySelector("#sf-refresh").addEventListener("click", () => load());

    },

    mount() {
        load();
        clearInterval(timer);
        timer = setInterval(load, 6000);
    },

    unmount() {
        clearInterval(timer);
        timer = null;
        host = null;
    }

};

async function load() {

    if (!host) return;

    try {

        const [status, jejak] = await Promise.allSettled([
            api.safety(),
            api.safetyTrail(60)
        ]);

        if (status.status === "rejected") throw status.reason;

        snapshot = status.value.data;

        // Jejak yang gagal dibaca tidak boleh mengosongkan panel —
        // keadaan rem lebih penting daripada riwayatnya.
        trail = jejak.status === "fulfilled" ? jejak.value.data : null;

        paint();

    }
    catch (e) {
        const body = host?.querySelector("#sf-body");
        if (body) {
            body.innerHTML =
                `<div class="card"><p class="small">Tidak bisa membaca status keselamatan: ${esc(e.message)}</p></div>`;
        }
    }

}

function paint() {

    const body = host?.querySelector("#sf-body");
    if (!body || !snapshot) return;

    const s = snapshot;
    const destruktif = s.risk?.destructive ?? 0;
    const total = s.risk?.total ?? 0;

    body.innerHTML = `
        <div class="sf-grid">
            <div class="sf-col sf-col-main">
                ${stopCard(s)}
                ${gateCard(destruktif, total)}
            </div>
            <div class="sf-col sf-col-side">
                ${trailCard(trail)}
            </div>
        </div>
    `;

    wire();

}

/** Kartu utama: keadaan berhenti/berjalan. */
function stopCard(s) {

    const engaged = s.engaged === true;

    return `
        <div class="card sf-stop ${engaged ? "engaged" : ""}">
            <div class="sf-stop-body">
                <div class="sf-stop-icon">
                    ${engaged
                        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`
                        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l2 2"/></svg>`}
                </div>
                <div class="sf-stop-info">
                    <div class="sf-stop-label">Keadaan Sistem</div>
                    <div class="sf-stop-state ${engaged ? "stopped" : "running"}">
                        ${engaged ? "DIHENTIKAN" : "BERJALAN"}
                    </div>
                    ${engaged ? `<div class="sf-stop-detail">
                        ${esc(s.reason ?? "tanpa alasan")} · oleh ${esc(s.actor ?? "?")}
                        ${s.since ? ` · ${esc(new Date(s.since).toLocaleString("id-ID"))}` : ""}
                    </div>` : `<div class="sf-stop-detail">
                        Semua tool dan tugas otonom berjalan tanpa ditahan.
                    </div>`}
                </div>
                <button class="btn ${engaged ? "" : "danger"} sf-stop-btn" id="sf-toggle">
                    ${engaged ? "Lanjutkan" : "Hentikan"}
                </button>
            </div>
        </div>
    `;

}

/** Klasifikasi risiko — informasi saja, tidak menahan apa pun. */
function gateCard(destruktif, total) {

    return `
        <div class="card sf-gate">
            <div class="sf-gate-header">
                <div class="sf-gate-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                </div>
                <div class="sf-gate-title">
                    <div class="sf-gate-label">Klasifikasi Risiko</div>
                    <div class="sf-gate-state inactive">TANPA GERBANG</div>
                </div>
            </div>

            <div class="sf-gate-stats">
                <div class="sf-gate-stat">
                    <div class="sf-gate-stat-num ${destruktif > 0 ? "danger" : ""}">${destruktif}</div>
                    <div class="sf-gate-stat-label">Destruktif</div>
                </div>
                <div class="sf-gate-stat">
                    <div class="sf-gate-stat-num">${total}</div>
                    <div class="sf-gate-stat-label">Total Tool</div>
                </div>
                <div class="sf-gate-stat">
                    <div class="sf-gate-stat-num ok">${total - destruktif}</div>
                    <div class="sf-gate-stat-label">Aman</div>
                </div>
            </div>

            <div class="sf-gate-warning">
                <strong>Tanpa gerbang:</strong> semua eksekusi diizinkan —
                termasuk ${destruktif} tool destruktif.
                <br><span class="dim">Yang tetap berjalan: STOP, sandbox jalur, verifikasi, jejak audit.</span>
            </div>
        </div>
    `;

}

/** Tampilan per hasil — sengaja tidak menyamarkan yang bermasalah. */
const OUTCOME = {
    ok:      { label: "berjalan",  color: "var(--ok)" },
    denied:  { label: "ditahan",   color: "var(--warn)" },
    error:   { label: "gagal",     color: "var(--danger)" }
};

const VERIFY = {
    verified:   { label: "terbukti",        color: "var(--ok)" },
    failed:     { label: "BUKTI GAGAL",     color: "var(--danger)" },
    unverified: { label: "belum terbukti",  color: "var(--warn)" },
    skipped:    { label: "—",               color: "var(--dim)" }
};

/** Jejak audit — apa yang benar-benar Damar lakukan. */
function trailCard(t) {

    if (!t) {
        return `
            <div class="card sf-trail">
                <div class="sf-trail-head">
                    <div class="small dim">Jejak Tindakan</div>
                </div>
                <p class="small" style="margin-top:8px">Jejak belum bisa dibaca.</p>
            </div>
        `;
    }

    const s = t.summary ?? {};
    const entries = t.entries ?? [];

    if (!entries.length) {
        return `
            <div class="card sf-trail">
                <div class="sf-trail-head">
                    <div class="small dim">Jejak Tindakan</div>
                </div>
                <p class="small" style="margin-top:8px">
                    Belum ada tindakan destruktif yang tercatat.
                </p>
            </div>
        `;
    }

    const rows = entries.slice(0, 15).map(e => {

        const o = OUTCOME[e.outcome] ?? { label: e.outcome ?? "?", color: "var(--dim)" };
        const v = e.verification ? VERIFY[e.verification] : null;
        const jam = e.at ? new Date(e.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
        const destruktif = e.risk === "destructive";

        return `
            <div class="sf-trail-row ${destruktif ? "destructive" : ""}">
                <span class="sf-trail-time">${esc(jam)}</span>
                <span class="sf-trail-risk">${destruktif ? "DESTRUKTIF" : "aman"}</span>
                <span class="sf-trail-tool" title="${esc(e.tool ?? "?")}">${esc(e.tool ?? "?")}</span>
                <span class="sf-trail-outcome" style="color:${o.color}">${esc(o.label)}</span>
                <span class="sf-trail-verify" style="color:${v ? v.color : "var(--dim)"}">
                    ${v ? esc(v.label) : ""}${e.checks ? ` <span class="dim">${esc(e.checks)}</span>` : ""}
                </span>
            </div>
        `;

    }).join("");

    const masalah = (s.denied ?? 0) + (s.error ?? 0) + (s.verifiedFailed ?? 0);

    return `
        <div class="card sf-trail">
            <div class="sf-trail-head">
                <div class="small dim">Jejak Tindakan — ${t.retentionDays ?? 14} hari</div>
                ${masalah
                    ? `<div class="sf-trail-alert">${s.denied ?? 0} ditahan · ${s.error ?? 0} gagal</div>`
                    : `<div class="sf-trail-clean">semua bersih</div>`}
            </div>
            <div class="sf-trail-list">${rows}</div>
        </div>
    `;

}

function wire() {

    const toggle = host?.querySelector("#sf-toggle");

    if (toggle) {
        toggle.addEventListener("click", async () => {
            try {
                if (snapshot.engaged) {
                    await api.safetyRelease();
                    toast("Damar dilanjutkan", "ok");
                }
                else {
                    await api.safetyStop("dihentikan dari panel Keamanan");
                    toast("Damar dihentikan", "warn");
                }
                await load();
            }
            catch (e) { toast(`Gagal: ${e.message}`, "err"); }
        });
    }

}
