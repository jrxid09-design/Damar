import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";

/**
 * Aether OSINT — anak buah Aether, detektif digital.
 *
 * Empat pilar:
 *   1. Investigasi Cepat — email, username, telepon, domain (korelasi otomatis).
 *   2. Kebocoran Data — cek di mana bocor & apa yang terekspos (GRATIS).
 *   3. Telepon — analisis risiko penipuan, blacklist, live call assessment.
 *   4. Pelacakan — lokasi orang yang opt-in (bukan hanya keluarga).
 *
 * Semua sumber GRATIS. Hanya untuk investigasi yang sah.
 *
 * Setiap sumber punya aturan deteksi yang sudah diuji terhadap situs
 * aslinya, dan hasilnya punya TIGA keadaan: ada, tidak ada, dan tidak
 * pasti. Keadaan ketiga ditampilkan apa adanya — sumber yang menolak
 * menjawab bukan bukti bahwa akunnya tidak ada, dan menyamarkannya
 * jadi "tidak ada" akan membuat laporan tampak lebih meyakinkan
 * daripada kenyataannya.
 */
export const family = {

    id: "family",
    label: "Aether OSINT",
    icon: "search",
    title: "Aether OSINT",
    subtitle: "Anak buah Aether — investigasi, kebocoran data, penipuan telepon, pelacakan.",

    render(root) {
        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Aether OSINT</h1>
                    <p>Anak buah Aether — investigasi sah, bukan pelanggaran privasi.</p>
                </div>
                <div class="actions">
                    <span class="pill ok"><span class="dot"></span>18 sumber terverifikasi</span>
                </div>
            </div>

            <div class="seg osint-nav" id="osint-tabs" style="margin-bottom:16px">
                <button type="button" data-tab="investigate" class="active">${icon("search")} Investigasi</button>
                <button type="button" data-tab="breach">${icon("shield")} Kebocoran</button>
                <button type="button" data-tab="phone">${icon("bell")} Telepon</button>
                <button type="button" data-tab="track">${icon("home")} Pelacakan</button>
                <button type="button" data-tab="social">${icon("activity")} Social</button>
            </div>

            <div class="osint-note small dim">
                ${icon("alert")} Mode siaga: sumber publik kadang berubah tanpa pamit. Bila satu jalur
                gagal, coba jalur lain — temuan lain tetap tersimpan di kasus.
            </div>

            <div id="osint-content"></div>`;
    },

    async mount(root) {
        const tabs = root.querySelectorAll("#osint-tabs [data-tab]");
        const content = root.querySelector("#osint-content");

        const open = async (tab) => {
            tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
            content.innerHTML = "";

            if (tab === "investigate") await renderInvestigate(content);
            else if (tab === "breach") await renderBreach(content);
            else if (tab === "phone") await renderPhone(content);
            else if (tab === "track") await renderTrack(content);
            else if (tab === "social") await renderSocial(content);
        };

        tabs.forEach(b => b.addEventListener("click", () => open(b.dataset.tab)));
        await open("investigate");
    }

};

// ---- Investigasi Cepat ---------------------------------------------

async function renderInvestigate(host) {
    host.innerHTML = `
        <div class="stack">
            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("search")} Investigasi Cepat</h2>
                    <span class="hint push">email · username · telepon · domain</span>
                </div>
                <div class="grid cols-2" style="gap:10px">
                    <div class="field"><label>Email</label><input type="text" id="os-email" placeholder="target@email.com"></div>
                    <div class="field">
                        <label>Username <span class="dim">— termasuk akun, kanal &amp; grup Telegram</span></label>
                        <input type="text" id="os-username" placeholder="username / nama grup t.me">
                    </div>
                    <div class="field"><label>Telepon</label><input type="text" id="os-phone" placeholder="+62..."></div>
                    <div class="field"><label>Domain</label><input type="text" id="os-domain" placeholder="example.com"></div>
                </div>
                <div class="row" style="margin-top:12px;gap:8px">
                    <button class="btn primary" id="os-investigate">${icon("search")} Investigasi</button>
                    <button class="btn ghost" id="os-clear">Bersihkan</button>
                </div>
                <div id="os-result" style="margin-top:14px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("activity")} Kasus Investigasi</h2>
                    <button class="btn sm push" id="os-refresh-cases">${icon("refresh")}</button>
                </div>
                <div class="row" style="gap:8px;margin-bottom:12px">
                    <input type="text" id="os-case-title" placeholder="Judul kasus baru…" style="flex:1">
                    <button class="btn primary sm" id="os-case-create">${icon("plus")} Buat</button>
                </div>
                <div id="os-cases"></div>
            </div>
        </div>`;

    await refreshCases(host);

    host.querySelector("#os-investigate").addEventListener("click", () => runInvestigation(host));
    host.querySelector("#os-clear").addEventListener("click", () => {
        host.querySelector("#os-email").value = "";
        host.querySelector("#os-username").value = "";
        host.querySelector("#os-phone").value = "";
        host.querySelector("#os-domain").value = "";
        host.querySelector("#os-result").innerHTML = "";
    });

    host.querySelector("#os-case-create").addEventListener("click", async () => {
        const title = host.querySelector("#os-case-title").value.trim();
        if (!title) return toast("Isi judul kasus.", "warn");
        try {
            await api.osintCaseCreate({ title });
            host.querySelector("#os-case-title").value = "";
            await refreshCases(host);
            toast("Kasus dibuat", "ok");
        }
        catch (e) { toast(e.message, "danger"); }
    });

    host.querySelector("#os-refresh-cases").addEventListener("click", () => refreshCases(host));
}

async function runInvestigation(host) {
    const target = {};
    const email = host.querySelector("#os-email").value.trim();
    const username = host.querySelector("#os-username").value.trim();
    const phone = host.querySelector("#os-phone").value.trim();
    const domain = host.querySelector("#os-domain").value.trim();

    if (email) target.email = email;
    if (username) target.username = username;
    if (phone) target.phone = phone;
    if (domain) target.domain = domain;

    if (Object.keys(target).length === 0) {
        return toast("Isi minimal satu target.", "warn");
    }

    const out = host.querySelector("#os-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Menginvestigasi… (mungkin butuh 10-20 detik)</span></div>`;

    try {
        out.innerHTML = renderReport(await api.osintInvestigate(target));
    }
    catch (e) {
        out.innerHTML = `
            <div class="osint-error">
                ${icon("alert")}
                <div>
                    <div class="ttl">Jalur investigasi gagal</div>
                    <div class="desc">${esc(e.message)}</div>
                    <div class="hint">Sumber publik kadang menolak. Tunggu sebentar lalu coba lagi,
                    atau coba target/jalur lain — temuan lama tersimpan di kasus.</div>
                </div>
            </div>`;
    }
}

/**
 * Gambar laporan investigasi.
 *
 * Versi lama membaca `r.risk`, `r.score`, dan `r.findings` sebagai
 * angka, padahal daemon mengirim `riskLevel`, `riskScore`, dan
 * `findings` sebagai ARRAY — jadi kotak hasilnya selalu menampilkan
 * "? · skor 0 · [object Object] temuan". Di sini bentuk yang benar
 * yang dibaca, dan isi tiap seksi ikut ditampilkan: temuan mentah
 * jauh lebih berguna daripada sekadar skor.
 */
function renderReport(r) {

    const findings = Array.isArray(r.findings) ? r.findings : [];
    const correlations = Array.isArray(r.correlations) ? r.correlations : [];
    const sections = r.sections ?? {};

    const level = r.riskLevel ?? "RENDAH";
    const tone = level === "TINGGI" ? "danger" : level === "SEDANG" ? "warn" : "ok";

    return `
        <div class="osint-result">

            <div class="osint-verdict" data-tone="${tone}">
                <div class="risk">${pill(level, tone)}</div>
                <div class="score">skor ${r.riskScore ?? 0}<span>/100</span></div>
                <div class="finds">${findings.length} temuan</div>
            </div>

            ${r.summary ? `<p class="osint-summary">${esc(r.summary)}</p>` : ""}

            ${correlations.length ? `
                <div class="osint-block">
                    <div class="ttl">${icon("link")} Korelasi antar-identitas</div>
                    ${correlations.map(c => `<div class="line">• ${esc(c.detail ?? "")}</div>`).join("")}
                </div>` : ""}

            ${sectionEmail(sections.email)}
            ${sectionUsername(sections.username)}
            ${sectionTelegram(sections.telegram)}
            ${sectionPhone(sections.phone)}
            ${sectionDomain(sections.domain)}

        </div>`;
}

function sectionEmail(e) {
    if (!e) return "";
    if (!e.valid) return `<div class="osint-block"><div class="ttl">${icon("chat")} Email</div>
        <div class="line">${esc(e.error ?? "tidak valid")}</div></div>`;

    const tags = [
        e.isDisposable ? "sekali pakai" : null,
        e.isFree ? "penyedia gratis" : null,
        e.isCorporate ? "domain sendiri" : null,
        e.hasPlus ? "pakai alias +" : null
    ].filter(Boolean);

    const x = e.exposure;

    return `<div class="osint-block">
        <div class="ttl">${icon("chat")} Email — ${esc(e.masked ?? e.email)}</div>
        <div class="tags">${tags.map(t => `<span>${esc(t)}</span>`).join("")}</div>
        ${x ? `<div class="line" style="margin-top:6px">
            ${x.breached
                ? `Ditemukan di <b>${x.count}</b> kebocoran${x.sources?.length ? `: ${esc(x.sources.join(", "))}` : ""}.
                   ${x.fields?.length ? `Data terekspos: ${esc(x.fields.join(", "))}.` : ""}`
                : "Tidak ditemukan di kebocoran yang diketahui."}
        </div>` : ""}
    </div>`;
}

/**
 * Tiga keadaan, bukan dua. "Tidak pasti" ditampilkan apa adanya —
 * sumber yang memblokir kita bukan bukti bahwa akunnya tidak ada.
 */
function sectionUsername(u) {
    if (!u) return "";

    const rows = (u.results ?? []).slice().sort((a, b) => {
        const rank = v => v.found === true ? 0 : v.found === null ? 1 : 2;
        return rank(a) - rank(b) || String(a.platform).localeCompare(String(b.platform));
    });

    return `<div class="osint-block">
        <div class="ttl">${icon("search")} Username — ${esc(u.username)}</div>
        <div class="line" style="margin-bottom:8px">
            <b>${u.platformsFound}</b> ditemukan ·
            <b>${(u.platformsChecked ?? 0) - (u.platformsFound ?? 0) - (u.platformsUnsure ?? 0)}</b> tidak ada ·
            <b>${u.platformsUnsure ?? 0}</b> tidak pasti
            <span class="dim">(dari ${u.platformsChecked ?? 0} sumber)</span>
        </div>
        <div class="osint-hits">
            ${rows.map(p => {
                const cls = p.found === true ? "hit" : p.found === null ? "unsure" : "miss";
                const label = p.found === true ? "ada" : p.found === null ? "tidak pasti" : "tidak ada";
                const inner = `<span class="nm">${esc(p.platform)}</span><span class="st">${label}</span>`;
                return p.found === true
                    ? `<a class="oh ${cls}" href="${esc(p.url)}" target="_blank" rel="noreferrer"
                          title="${esc(p.note ?? p.url ?? "")}">${inner}</a>`
                    : `<span class="oh ${cls}" title="${esc(p.note ?? "")}">${inner}</span>`;
            }).join("")}
        </div>
    </div>`;
}

function sectionTelegram(t) {
    if (!t) return "";
    if (t.error) return `<div class="osint-block"><div class="ttl">${icon("chat")} Telegram</div>
        <div class="line">${esc(t.error)}</div></div>`;

    if (!t.exists) return `<div class="osint-block"><div class="ttl">${icon("chat")} Telegram</div>
        <div class="line">Tidak ada akun, kanal, atau grup dengan nama itu.</div></div>`;

    return `<div class="osint-block">
        <div class="ttl">${icon("chat")} Telegram — ${esc(t.kind ?? "akun")}</div>
        <div class="line">
            <b>${esc(t.title ?? t.name)}</b>
            ${t.members != null ? ` · ${Number(t.members).toLocaleString("id-ID")} ${t.kind === "grup" ? "anggota" : "pelanggan"}` : ""}
        </div>
        ${t.description ? `<div class="line dim">${esc(t.description)}</div>` : ""}
        <div class="line"><a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url)}</a></div>
    </div>`;
}

function sectionPhone(p) {
    if (!p) return "";
    if (!p.valid) return `<div class="osint-block"><div class="ttl">${icon("activity")} Telepon</div>
        <div class="line">${esc(p.error ?? "tidak valid")}</div></div>`;

    return `<div class="osint-block">
        <div class="ttl">${icon("activity")} Telepon — ${esc(p.masked)}</div>
        <div class="tags">
            <span>${esc(p.country ?? "negara tak dikenal")}</span>
            ${p.countryCode ? `<span>+${esc(p.countryCode)}</span>` : ""}
            <span>${p.length} digit</span>
            <span>${esc((p.possibleTypes ?? []).join(" / "))}</span>
        </div>
    </div>`;
}

function sectionDomain(d) {
    if (!d) return "";
    const ips = d.dns?.ips ?? [];
    return `<div class="osint-block">
        <div class="ttl">${icon("server")} Domain — ${esc(d.domain)}</div>
        <div class="line">${ips.length ? `IP: ${esc(ips.join(", "))}` : (d.dns?.error ? `DNS gagal: ${esc(d.dns.error)}` : "Tidak ada A record.")}</div>
        ${d.mx?.length ? `<div class="line dim">MX: ${esc(d.mx.slice(0, 3).join(" · "))}</div>` : ""}
        ${d.http?.status ? `<div class="line dim">HTTP ${d.http.status}${d.http.server ? ` · ${esc(d.http.server)}` : ""}</div>` : ""}
    </div>`;
}

async function refreshCases(host) {
    const body = host.querySelector("#os-cases");
    try {
        const { cases } = await api.osintCaseList();
        body.innerHTML = cases.length === 0
            ? `<div class="empty">${icon("activity")}<div>Belum ada kasus. Buat satu untuk mulai mengorganisir investigasi.</div></div>`
            : cases.map(c => `
                <div class="row" style="align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
                    <div style="flex:1">
                        <div style="font-weight:600">${esc(c.title)}</div>
                        <div class="small dim">${c.findings} temuan · ${esc(c.status)} · ${esc(c.updated?.slice(0,10) ?? "")}</div>
                    </div>
                    <button class="btn sm" data-case-view="${esc(c.id)}">Lihat</button>
                    <button class="btn sm danger" data-case-del="${esc(c.id)}">${icon("trash")}</button>
                </div>`).join("");

        body.querySelectorAll("[data-case-view]").forEach(btn => {
            btn.addEventListener("click", () => viewCase(host, btn.dataset.caseView));
        });
        body.querySelectorAll("[data-case-del]").forEach(btn => {
            btn.addEventListener("click", async () => {
                if (!confirm("Hapus kasus ini?")) return;
                try { await api.osintCaseDelete(btn.dataset.caseDel); await refreshCases(host); toast("Kasus dihapus", "ok"); }
                catch (e) { toast(e.message, "danger"); }
            });
        });
    }
    catch (e) { body.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function viewCase(host, caseId) {
    try {
        const c = await api.osintCaseDetail(caseId);
        const caseData = c.case ?? c;

        const modal = document.createElement("div");
        modal.className = "aether-present show";
        modal.innerHTML = `
            <div class="ap-card" style="max-width:min(800px,90vw);max-height:85vh;overflow-y:auto">
                <button class="ap-close">✕</button>
                <div style="padding:20px">
                    <h2 style="margin:0 0 4px">${esc(caseData.title)}</h2>
                    <div class="small dim">${esc(caseData.status)} · dibuat ${esc(caseData.createdAt?.slice(0,10) ?? "")}</div>

                    <div class="divider"></div>

                    <div class="small"><b>Target:</b> ${Object.entries(caseData.target ?? {}).filter(([k,v]) => v).map(([k,v]) => `${k}: ${v}`).join(" · ") || "—"}</div>

                    <div style="margin-top:12px">
                        <div class="small dim" style="margin-bottom:6px">Temuan (${caseData.findings?.length ?? 0})</div>
                        ${(caseData.findings ?? []).map(f => `
                            <div class="card" style="padding:10px;margin-bottom:6px">
                                <div class="row" style="gap:8px">
                                    ${pill(f.type, "info")}
                                    <span class="small dim">${esc(f.source)}</span>
                                    <span class="small dim push">${esc(f.at?.slice(0,16) ?? "")}</span>
                                </div>
                                <div class="small" style="margin-top:4px">${esc(JSON.stringify(f.data).slice(0, 200))}</div>
                            </div>
                        `).join("") || '<div class="small dim">Belum ada temuan.</div>'}
                    </div>

                    <div style="margin-top:12px">
                        <div class="small dim" style="margin-bottom:6px">Timeline</div>
                        ${(caseData.timeline ?? []).map(t => `
                            <div class="small" style="margin:4px 0">
                                <span class="dim">${esc(t.at?.slice(0,16) ?? "")}</span> — ${esc(t.event)}
                            </div>
                        `).join("")}
                    </div>

                    ${caseData.conclusion ? `
                        <div class="divider"></div>
                        <div class="small"><b>Kesimpulan:</b> ${esc(caseData.conclusion)}</div>
                        <div class="small"><b>Verdict:</b> ${esc(caseData.verdict ?? "—")}</div>
                    ` : ""}
                </div>
            </div>`;

        modal.querySelector(".ap-close").addEventListener("click", () => modal.remove());
        modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
    }
    catch (e) { toast(e.message, "danger"); }
}

// ---- Kebocoran Data (gratis) ----------------------------------------

async function renderBreach(host) {
    host.innerHTML = `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("shield")} Cek Kebocoran Data</h2>
                <span class="hint push">GRATIS — tanpa API key</span>
            </div>
            <div class="field">
                <label>Email / username (milikmu atau keluarga yang mengizinkan)</label>
                <div class="row" style="gap:8px">
                    <input type="text" id="br-query" placeholder="nama@email.com atau username" style="flex:1">
                    <button class="btn primary" id="br-check">${icon("search")} Cek Kebocoran</button>
                </div>
                <span class="help">Menunjukkan di mana bocor dan data apa saja yang terekspos. Sumber: LeakCheck + ProxyNova (gratis).</span>
            </div>
            <div id="br-result" style="margin-top:14px"></div>
        </div>`;

    host.querySelector("#br-check").addEventListener("click", () => runBreachCheck(host));
    host.querySelector("#br-query").addEventListener("keydown", e => { if (e.key === "Enter") runBreachCheck(host); });
}

async function runBreachCheck(host) {
    const query = host.querySelector("#br-query").value.trim();
    const out = host.querySelector("#br-result");
    if (!query) return toast("Isi email/username.", "warn");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Mengecek kebocoran…</span></div>`;

    try {
        const r = await api.osintBreach(query);
        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px">
                <div class="row" style="align-items:center;gap:10px">
                    ${r.breached ? pill("Bocor", "danger") : pill("Aman", "ok")}
                    <span class="small muted">${esc(r.summary?.detail ?? (r.breached
                        ? `Ditemukan di ${(r.sources ?? []).length} sumber.`
                        : "Tidak ditemukan di kebocoran yang diketahui."))}</span>
                </div>
                ${(r.errors ?? []).length ? `
                    <div class="small dim" style="margin-top:6px">
                        Sumber yang tidak menjawab: ${esc(r.errors.map(e => `${e.source} (${e.error})`).join(" · "))}
                    </div>` : ""}

                ${r.sources && r.sources.length ? `
                    <div style="margin-top:14px">
                        <!-- Kolom "Data terekspos" membaca dataClasses; nama
                             lama (data) tidak pernah dikirim layanan, jadi
                             kolomnya selalu kosong. -->
                        <div class="small dim" style="margin-bottom:8px">Bocor di mana:</div>
                        <div class="scroll-x"><table class="table">
                            <thead><tr><th>Layanan</th><th>Tahun</th><th>Kategori</th><th>Akun</th><th>Data terekspos</th></tr></thead>
                            <tbody>${r.sources.map(s => `<tr>
                                <td><b>${esc(s.name ?? "?")}</b></td>
                                <td class="mono small">${esc(s.year ?? "—")}</td>
                                <td class="small">${esc(s.category ?? "—")}</td>
                                <td class="mono small">${s.accounts ? (s.accounts / 1000000).toFixed(1) + " jt" : "—"}</td>
                                <td class="small">${esc((s.dataClasses ?? s.data ?? []).join(", ") || "—")}</td>
                            </tr>`).join("")}</tbody></table></div>
                    </div>` : ""}

                ${r.fields && r.fields.length ? `
                    <div style="margin-top:12px">
                        <div class="small dim">Data yang terekspos:</div>
                        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
                            ${r.fields.map(f => `<span class="tag" style="background:rgba(255,84,112,0.15);border-color:rgba(255,84,112,0.3);color:var(--danger)">${esc(f)}</span>`).join("")}
                        </div>
                    </div>` : ""}

                ${r.combos?.found ? `
                    <div style="margin-top:12px;padding:10px 12px;background:rgba(255,84,112,0.08);border:1px solid rgba(255,84,112,0.25);border-radius:var(--r-md)">
                        <div class="small" style="color:var(--danger)"><b>Combo list ditemukan:</b> ${r.combos.count} entri email:password</div>
                        <div class="small dim" style="margin-top:4px">Domain: ${esc(r.combos.domains.join(", "))}</div>
                    </div>` : ""}

                <div style="margin-top:14px">
                    <div class="small dim" style="margin-bottom:6px">Saran:</div>
                    <ul class="small" style="margin:0;padding-left:18px">${r.advice.map(a => `<li>${esc(a)}</li>`).join("")}</ul>
                </div>
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

// ---- Telepon Intelijen ------------------------------------------------

async function renderPhone(host) {
    host.innerHTML = `
        <div class="stack">
            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("bell")} Analisis Telepon</h2>
                    <span class="hint push">mitigasi penipuan</span>
                </div>
                <div class="field">
                    <label>Nomor telepon (dengan atau tanpa kode negara)</label>
                    <div class="row" style="gap:8px">
                        <input type="text" id="ph-number" placeholder="+62 812 3456 7890" style="flex:1">
                        <button class="btn primary" id="ph-analyze">${icon("search")} Analisis</button>
                    </div>
                </div>
                <div id="ph-result" style="margin-top:14px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("activity")} Penilaian Panggilan Live</h2>
                    <span class="hint push">saat ponsel berdering</span>
                </div>
                <div class="grid cols-2" style="gap:10px">
                    <div class="field"><label>Nomor penelepon</label><input type="text" id="ph-live-number" placeholder="+62..."></div>
                    <div class="field"><label>Durasi (detik)</label><input type="number" id="ph-live-duration" placeholder="0" value="0"></div>
                </div>
                <div class="row" style="margin-top:10px;gap:8px">
                    <button class="btn primary" id="ph-assess">${icon("activity")} Nilai Panggilan</button>
                    <span class="small dim">Dipakai saat ponsel berdering (lewat Tasker/FTS).</span>
                </div>
                <div id="ph-live-result" style="margin-top:14px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("shield")} Blacklist & Whitelist</h2>
                </div>
                <div class="row" style="gap:8px;margin-bottom:12px">
                    <input type="text" id="ph-list-number" placeholder="Nomor untuk blacklist/whitelist…" style="flex:1">
                    <button class="btn danger sm" id="ph-blacklist-add">${icon("plus")} Blacklist</button>
                    <button class="btn ok sm" id="ph-whitelist-add">${icon("check")} Whitelist</button>
                </div>
                <div id="ph-list"></div>
            </div>
        </div>`;

    await refreshPhoneList(host);

    host.querySelector("#ph-analyze").addEventListener("click", () => runPhoneAnalyze(host));
    host.querySelector("#ph-assess").addEventListener("click", () => runPhoneAssess(host));
    host.querySelector("#ph-blacklist-add").addEventListener("click", () => phoneListAction(host, "blacklist"));
    host.querySelector("#ph-whitelist-add").addEventListener("click", () => phoneListAction(host, "whitelist"));
}

async function runPhoneAnalyze(host) {
    const phone = host.querySelector("#ph-number").value.trim();
    const out = host.querySelector("#ph-result");
    if (!phone) return toast("Isi nomor telepon.", "warn");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Menganalisis…</span></div>`;

    try {
        const r = await api.osintPhoneAnalyze(phone);
        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px">
                <div class="row" style="align-items:center;gap:10px">
                    ${pill(r.riskLevel, r.riskLevel === "TINGGI" ? "danger" : r.riskLevel === "SEDANG" ? "warn" : "ok")}
                    <span class="small muted">skor ${r.scamScore}/100</span>
                </div>
                <div class="grid cols-2" style="gap:10px;margin-top:12px">
                    <div><div class="small dim">Negara</div><div class="small">${esc(r.country ?? "—")}</div></div>
                    <div><div class="small dim">Carrier</div><div class="small">${esc(r.carrier ?? "—")}</div></div>
                    <div><div class="small dim">Jenis</div><div class="small">${esc(r.lineType ?? "—")}</div></div>
                    <div><div class="small dim">Panjang</div><div class="small mono">${r.length} digit</div></div>
                </div>
                <div style="margin-top:12px">
                    <div class="small dim" style="margin-bottom:4px">Catatan:</div>
                    <!-- Layanan menamainya scamNotes; nama lama (notes) tidak
                         pernah ada, jadi .map() di sini melempar dan seluruh
                         tab Telepon berakhir sebagai pesan error. -->
                    <ul class="small" style="margin:0;padding-left:18px">${
                        (r.scamNotes ?? r.notes ?? []).map(n => `<li>${esc(n)}</li>`).join("")
                        || "<li>Tidak ada catatan khusus.</li>"}</ul>
                </div>
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function runPhoneAssess(host) {
    const phone = host.querySelector("#ph-live-number").value.trim();
    const duration = Number(host.querySelector("#ph-live-duration").value) || 0;
    const out = host.querySelector("#ph-live-result");
    if (!phone) return toast("Isi nomor penelepon.", "warn");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Menilai…</span></div>`;

    try {
        const r = await api.osintPhoneAssess(phone, { duration, answered: duration > 0 });
        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px;border-color:${r.liveScore >= 70 ? "rgba(255,84,112,0.5)" : r.liveScore >= 40 ? "rgba(255,200,87,0.5)" : "rgba(52,211,153,0.3)"}">
                <div style="font:700 18px/1.2 var(--font-hud);color:${r.liveScore >= 70 ? "var(--danger)" : r.liveScore >= 40 ? "var(--warn)" : "var(--ok)"}">
                    ${esc(r.verdict)}
                </div>
                <div class="small" style="margin-top:8px">${esc(r.recommendation)}</div>
                <div class="small dim" style="margin-top:8px">
                    Panggilan ke-${r.callCount} · skor ${r.liveScore}/100
                </div>
                <div style="margin-top:8px">
                    <ul class="small" style="margin:0;padding-left:18px">${
                        [...(r.liveNotes ?? []), ...(r.scamNotes ?? [])]
                            .map(n => `<li>${esc(n)}</li>`).join("")
                        || "<li>Tidak ada catatan khusus.</li>"}</ul>
                </div>
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function phoneListAction(host, action) {
    const phone = host.querySelector("#ph-list-number").value.trim();
    if (!phone) return toast("Isi nomor telepon.", "warn");

    try {
        if (action === "blacklist") {
            await api.osintPhoneBlacklistAdd(phone);
            toast("Ditambahkan ke blacklist", "ok");
        } else {
            await api.osintPhoneWhitelistAdd(phone);
            toast("Ditambahkan ke whitelist", "ok");
        }
        host.querySelector("#ph-list-number").value = "";
        await refreshPhoneList(host);
    }
    catch (e) { toast(e.message, "danger"); }
}

async function refreshPhoneList(host) {
    const body = host.querySelector("#ph-list");
    try {
        const r = await api.osintPhoneList();
        body.innerHTML = `
            <div class="grid cols-2" style="gap:14px">
                <div>
                    <div class="small dim" style="margin-bottom:6px">Blacklist (${r.blacklist.length})</div>
                    ${r.blacklist.length ? r.blacklist.map(p => `<div class="small mono" style="margin:4px 0">${esc(p)}</div>`).join("") : '<div class="small dim">Kosong</div>'}
                </div>
                <div>
                    <div class="small dim" style="margin-bottom:6px">Whitelist (${r.whitelist.length})</div>
                    ${r.whitelist.length ? r.whitelist.map(p => `<div class="small mono" style="margin:4px 0">${esc(p)}</div>`).join("") : '<div class="small dim">Kosong</div>'}
                </div>
            </div>
            ${r.history.length ? `
                <div style="margin-top:14px">
                    <div class="small dim" style="margin-bottom:6px">Riwayat panggilan:</div>
                    ${r.history.slice(0, 10).map(h => `
                        <div class="row" style="align-items:center;gap:10px;margin:4px 0;font-size:11.5px">
                            <span class="mono">${esc(h.phone)}</span>
                            <span class="dim">${h.count}× panggilan</span>
                            <span class="dim">skor ${h.lastScore}</span>
                            <span class="dim push">${esc(h.lastSeen?.slice(0,16) ?? "")}</span>
                        </div>
                    `).join("")}
                </div>` : ""}`;
    }
    catch (e) { body.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

// ---- Pelacakan Orang -------------------------------------------------

async function renderTrack(host) {
    host.innerHTML = `
        <div class="stack">
            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("home")} Daftarkan Orang untuk Dilacak</h2>
                    <span class="hint push">opt-in per perangkat</span>
                </div>

                <!-- Metodenya harus dijelaskan, bukan ditebak sendiri:
                     pelacakan di sini BUKAN menyadap nomor, melainkan
                     tautan izin yang dibuka orangnya di ponselnya. -->
                <div class="osint-note">
                    ${icon("shield")}
                    <div>
                        <b>Cara kerjanya:</b> Aether tidak menyadap nomor atau
                        membobol apa pun. Kamu mendaftarkan orangnya di sini, lalu
                        mendapat <b>satu tautan izin</b>. Orang itu membuka tautan
                        tersebut di ponselnya dan menekan "izinkan lokasi" —
                        sejak itu ponselnya sendiri yang mengirim posisinya.
                        <span class="dim">Tautan muncul sekali saja setelah
                        didaftarkan. Tanpa dibuka orangnya, tidak ada data apa pun,
                        dan izin bisa dicabut kapan saja lewat tombol Cabut.</span>
                    </div>
                </div>

                <div class="grid cols-3" style="gap:10px">
                    <div class="field"><label>Nama</label><input type="text" id="tr-name" placeholder="Nama orang"></div>
                    <div class="field"><label>Label</label><input type="text" id="tr-label" placeholder="Istri/Anak/Karyawan"></div>
                    <div class="field"><label>Grup</label><input type="text" id="tr-group" placeholder="Keluarga/Tim"></div>
                </div>
                <div class="row" style="margin-top:10px;gap:8px">
                    <button class="btn primary" id="tr-register">${icon("plus")} Daftarkan</button>
                </div>
                <div id="tr-token" style="margin-top:12px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("activity")} Orang yang Dilacak</h2>
                    <button class="btn sm push" id="tr-refresh">${icon("refresh")}</button>
                </div>
                <div id="tr-list"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("home")} Siapa di Dekat Siapa</h2>
                </div>
                <div class="row" style="gap:8px;margin-bottom:12px">
                    <input type="number" id="tr-radius" placeholder="Radius (meter)" value="1000" style="width:120px">
                    <button class="btn sm" id="tr-nearby">${icon("search")} Cek</button>
                </div>
                <div id="tr-nearby-result"></div>
            </div>
        </div>`;

    await refreshTrackList(host);

    host.querySelector("#tr-register").addEventListener("click", async () => {
        const name = host.querySelector("#tr-name").value.trim();
        const label = host.querySelector("#tr-label").value.trim();
        const group = host.querySelector("#tr-group").value.trim();
        if (!name) return toast("Isi nama.", "warn");

        try {
            const r = await api.osintTrackRegister({ name, label, group });
            host.querySelector("#tr-name").value = "";
            host.querySelector("#tr-label").value = "";
            host.querySelector("#tr-group").value = "";
            await refreshTrackList(host);

            const out = host.querySelector("#tr-token");
            out.innerHTML = `
                <div class="card" style="padding:12px;background:rgba(52,211,153,0.08);border-color:rgba(52,211,153,0.3)">
                    <div class="small"><b>${esc(r.name)}</b> didaftarkan.</div>
                    <div class="small" style="margin-top:6px">Bagikan link ini ke perangkatnya (muncul SEKALI):</div>
                    <div class="row" style="gap:8px;margin-top:6px">
                        <input type="text" class="mono" readonly value="${esc(r.shareUrl)}" style="flex:1">
                        <button class="btn sm" id="tr-copy">${icon("copy")} Salin</button>
                    </div>
                </div>`;
            out.querySelector("#tr-copy").addEventListener("click", () => {
                navigator.clipboard.writeText(r.shareUrl).then(() => toast("Link disalin", "ok"));
            });
        }
        catch (e) { toast(e.message, "danger"); }
    });

    host.querySelector("#tr-refresh").addEventListener("click", () => refreshTrackList(host));
    host.querySelector("#tr-nearby").addEventListener("click", () => checkNearby(host));
}

async function refreshTrackList(host) {
    const body = host.querySelector("#tr-list");
    try {
        const { persons } = await api.osintTrackList();
        body.innerHTML = persons.length === 0
            ? `<div class="empty">${icon("home")}<div>Belum ada orang yang dilacak.</div></div>`
            : persons.map(p => `
                <div class="row" style="align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
                    <div style="flex:1">
                        <div style="font-weight:600">${esc(p.name)}${p.label ? ` <span class="tag">${esc(p.label)}</span>` : ""}${p.group ? ` <span class="tag">${esc(p.group)}</span>` : ""}</div>
                        <div class="small dim">${p.sharing ? "Aktif berbagi" : "Menunggu perangkat"} · ${p.updatedAt ? esc(p.updatedAt.slice(0,16)) : "—"}</div>
                    </div>
                    ${p.location ? `<div class="small mono">${p.location.lat.toFixed(5)}, ${p.location.lng.toFixed(5)}</div>` : ""}
                    <button class="btn sm" data-track-view="${esc(p.id)}">Detail</button>
                    <button class="btn sm danger" data-track-del="${esc(p.id)}">${icon("trash")}</button>
                </div>`).join("");

        body.querySelectorAll("[data-track-view]").forEach(btn => {
            btn.addEventListener("click", () => viewTrackDetail(host, btn.dataset.trackView));
        });
        body.querySelectorAll("[data-track-del]").forEach(btn => {
            btn.addEventListener("click", async () => {
                if (!confirm("Cabut akses pelacakan?")) return;
                try { await api.osintTrackRevoke(btn.dataset.trackDel); await refreshTrackList(host); toast("Akses dicabut", "ok"); }
                catch (e) { toast(e.message, "danger"); }
            });
        });
    }
    catch (e) { body.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function viewTrackDetail(host, personId) {
    try {
        const p = await api.osintTrackDetail(personId);
        const person = p.person ?? p;

        const modal = document.createElement("div");
        modal.className = "aether-present show";
        modal.innerHTML = `
            <div class="ap-card" style="max-width:min(700px,90vw);max-height:85vh;overflow-y:auto">
                <button class="ap-close">✕</button>
                <div style="padding:20px">
                    <h2 style="margin:0 0 4px">${esc(person.name)}</h2>
                    <div class="small dim">${person.label ?? ""} ${person.group ? `· ${esc(person.group)}` : ""}</div>

                    <div class="divider"></div>

                    ${person.location ? `
                        <div class="small"><b>Lokasi terkini:</b> ${person.location.lat.toFixed(6)}, ${person.location.lng.toFixed(6)}</div>
                        <div class="small dim">Akurasi: ${person.location.accuracy ?? "?"} m · Baterai: ${person.location.battery ?? "?"}% · ${esc(person.location.at?.slice(0,16) ?? "")}</div>
                    ` : '<div class="small dim">Belum ada lokasi.</div>'}

                    ${person.history?.length ? `
                        <div style="margin-top:14px">
                            <div class="small dim" style="margin-bottom:8px">Riwayat 20 titik terakhir:</div>
                            ${person.history.map(h => `
                                <div class="row" style="align-items:center;gap:10px;margin:4px 0;font-size:11.5px">
                                    <span class="mono">${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}</span>
                                    <span class="dim">${h.accuracy ? `${h.accuracy}m` : ""}</span>
                                    <span class="dim push">${esc(h.at?.slice(11,16) ?? "")}</span>
                                </div>
                            `).join("")}
                        </div>` : ""}
                </div>
            </div>`;

        modal.querySelector(".ap-close").addEventListener("click", () => modal.remove());
        modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
    }
    catch (e) { toast(e.message, "danger"); }
}

async function checkNearby(host) {
    const radius = Number(host.querySelector("#tr-radius").value) || 1000;
    const out = host.querySelector("#tr-nearby-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Mengecek…</span></div>`;

    try {
        const r = await api.osintTrackNearby(radius);
        out.innerHTML = r.pairs.length === 0
            ? `<div class="small dim">Tidak ada yang berdekatan dalam radius ${radius} m.</div>`
            : r.pairs.map(p => `
                <div class="row" style="align-items:center;gap:10px;margin:6px 0;padding:10px;background:rgba(52,211,153,0.08);border-radius:var(--r-md)">
                    <span style="font-weight:600">${esc(p.a)}</span>
                    <span class="dim">↔</span>
                    <span style="font-weight:600">${esc(p.b)}</span>
                    <span class="dim push">${esc(p.distance)}</span>
                </div>
            `).join("");
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

// ---- Social Intelligence ---------------------------------------------

async function renderSocial(host) {
    host.innerHTML = `
        <div class="stack">
            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("activity")} Deteksi Bot</h2>
                    <span class="hint push">asli atau palsu?</span>
                </div>
                <div class="grid cols-2" style="gap:10px">
                    <div class="field"><label>Username</label><input type="text" id="si-username" placeholder="username"></div>
                    <div class="field"><label>Platform</label>
                        <select id="si-platform">
                            <option value="">— pilih —</option>
                            <option value="twitter">Twitter/X</option>
                            <option value="instagram">Instagram</option>
                            <option value="reddit">Reddit</option>
                            <option value="tiktok">TikTok</option>
                            <option value="youtube">YouTube</option>
                            <option value="facebook">Facebook</option>
                        </select>
                    </div>
                    <div class="field"><label>Followers</label><input type="number" id="si-followers" placeholder="0"></div>
                    <div class="field"><label>Following</label><input type="number" id="si-following" placeholder="0"></div>
                    <div class="field"><label>Posts</label><input type="number" id="si-posts" placeholder="0"></div>
                    <div class="field"><label>Akun dibuat</label><input type="date" id="si-created"></div>
                </div>
                <div class="field" style="margin-top:8px">
                    <label>Bio</label>
                    <textarea id="si-bio" rows="2" placeholder="Bio akun (opsional)"></textarea>
                </div>
                <div class="row" style="margin-top:12px;gap:8px">
                    <label class="switch"><input type="checkbox" id="si-verified"><span class="track"></span><span class="small">Terverifikasi</span></label>
                    <label class="switch"><input type="checkbox" id="si-avatar" checked><span class="track"></span><span class="small">Punya foto profil</span></label>
                    <button class="btn primary push" id="si-analyze">${icon("search")} Analisis Bot</button>
                </div>
                <div id="si-result" style="margin-top:14px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("search")} Lacak Komentar</h2>
                    <span class="hint push">di mana saja & apa isinya</span>
                </div>
                <div class="field">
                    <label>Username</label>
                    <div class="row" style="gap:8px">
                        <input type="text" id="si-comments-user" placeholder="username" style="flex:1">
                        <button class="btn primary" id="si-comments-trace">${icon("search")} Lacak</button>
                    </div>
                </div>
                <div id="si-comments-result" style="margin-top:14px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("home")} Estimasi Lokasi</h2>
                    <span class="hint push">dari pola aktivitas</span>
                </div>
                <div class="grid cols-2" style="gap:10px">
                    <div class="field"><label>Username</label><input type="text" id="si-loc-user" placeholder="username"></div>
                    <div class="field"><label>Lokasi di profil</label><input type="text" id="si-loc-profile" placeholder="Jakarta, Indonesia"></div>
                </div>
                <div class="field" style="margin-top:8px">
                    <label>Contoh posting (satu per baris, format: HH:MM teks)</label>
                    <textarea id="si-loc-posts" rows="3" placeholder="09:15 Pagi yang cerah&#10;12:30 Makan siang&#10;19:45 Selamat malam"></textarea>
                </div>
                <div class="row" style="margin-top:10px">
                    <button class="btn primary" id="si-loc-estimate">${icon("search")} Estimasi Lokasi</button>
                </div>
                <div id="si-loc-result" style="margin-top:14px"></div>
            </div>

            <div class="panel">
                <div class="panel-head">
                    <h2>${icon("shield")} Cek Hoax</h2>
                    <span class="hint push">verifikasi sebelum sebarkan</span>
                </div>
                <!-- Cukup tautannya: Aether yang membuka, mengambil
                     judul & isinya, lalu menilai. Menyuruh menyalin isi
                     artikel itu pekerjaan sia-sia, dan potongan pilihan
                     manusia biasanya kehilangan judulnya. -->
                <div class="field">
                    <label>Tautan beritanya</label>
                    <input type="text" id="si-hoax-claim"
                           placeholder="https://… — tempel link beritanya saja">
                    <div class="small dim" style="margin-top:4px">
                        Tidak punya tautannya? Boleh juga tulis klaimnya langsung.
                    </div>
                </div>
                <div class="row" style="margin-top:10px;gap:8px">
                    <button class="btn primary" id="si-hoax-check">${icon("search")} Cek Fakta</button>
                    <button class="btn ghost" id="si-hoax-trace">${icon("activity")} Lacak Penyebar</button>
                </div>
                <div id="si-hoax-result" style="margin-top:14px"></div>
            </div>
        </div>`;

    // Bot detection
    host.querySelector("#si-analyze").addEventListener("click", () => runBotDetection(host));
    host.querySelector("#si-username").addEventListener("keydown", e => { if (e.key === "Enter") runBotDetection(host); });

    // Comment tracing
    host.querySelector("#si-comments-trace").addEventListener("click", () => runCommentTrace(host));
    host.querySelector("#si-comments-user").addEventListener("keydown", e => { if (e.key === "Enter") runCommentTrace(host); });

    // Location estimation
    host.querySelector("#si-loc-estimate").addEventListener("click", () => runLocationEstimate(host));

    // Hoax check
    host.querySelector("#si-hoax-check").addEventListener("click", () => runHoaxCheck(host));
    host.querySelector("#si-hoax-trace").addEventListener("click", () => runHoaxTrace(host));
}

async function runBotDetection(host) {
    const username = host.querySelector("#si-username").value.trim();
    if (!username) return toast("Isi username.", "warn");

    const profile = {
        username,
        platform: host.querySelector("#si-platform").value || undefined,
        followers: Number(host.querySelector("#si-followers").value) || undefined,
        following: Number(host.querySelector("#si-following").value) || undefined,
        posts: Number(host.querySelector("#si-posts").value) || undefined,
        created_at: host.querySelector("#si-created").value || undefined,
        bio: host.querySelector("#si-bio").value.trim() || undefined,
        verified: host.querySelector("#si-verified").checked,
        has_avatar: host.querySelector("#si-avatar").checked
    };

    const out = host.querySelector("#si-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Menganalisis…</span></div>`;

    try {
        const r = await api.osintSocialBot(profile);
        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px;border-color:${r.is_bot ? "rgba(255,84,112,0.4)" : "rgba(52,211,153,0.3)"}">
                <div class="row" style="align-items:center;gap:10px">
                    ${pill(r.is_bot ? "BOT" : "ASLI", r.is_bot ? "danger" : "ok")}
                    <span class="small muted">skor ${r.bot_score}/100</span>
                    <span class="small muted push">${esc(r.confidence)}</span>
                </div>
                <div style="font:600 16px/1.3 var(--font-hud);margin-top:10px;color:${r.is_bot ? "var(--danger)" : "var(--ok)"}">
                    ${esc(r.verdict)}
                </div>
                ${r.notes.length ? `
                    <div style="margin-top:12px">
                        <div class="small dim" style="margin-bottom:6px">Catatan analisis:</div>
                        <ul class="small" style="margin:0;padding-left:18px">${r.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
                    </div>` : ""}
                ${r.metrics ? `
                    <div class="grid cols-3" style="gap:10px;margin-top:12px">
                        ${r.metrics.followers != null ? `<div><div class="small dim">Followers</div><div class="small mono">${r.metrics.followers}</div></div>` : ""}
                        ${r.metrics.following != null ? `<div><div class="small dim">Following</div><div class="small mono">${r.metrics.following}</div></div>` : ""}
                        ${r.metrics.postsPerDay != null ? `<div><div class="small dim">Post/hari</div><div class="small mono">${r.metrics.postsPerDay}</div></div>` : ""}
                    </div>` : ""}
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function runCommentTrace(host) {
    const username = host.querySelector("#si-comments-user").value.trim();
    if (!username) return toast("Isi username.", "warn");

    const out = host.querySelector("#si-comments-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Melacak komentar… (mungkin butuh 15-30 detik)</span></div>`;

    try {
        // Layanan mengirim `results` + `platformsFound`; versi lama di
        // sini membaca `platforms` + `found`, dua nama yang tidak
        // pernah ada — jadi panel selalu kosong sekalipun komentarnya
        // ketemu. Itu keluhan "masa gak ada hasilnya".
        const r = await api.osintSocialComments(username);
        const platforms = r.results ?? [];
        const ada = (r.commentCount ?? 0) > 0;

        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px">
                <div class="row" style="align-items:center;gap:10px">
                    ${pill(ada ? "Ditemukan" : "Tidak ada", ada ? "ok" : "idle")}
                    <span class="small muted">${esc(r.summary ?? "")}</span>
                    ${ada ? `<button class="btn sm push" data-loc-trace="${esc(r.traceId)}">
                        ${icon("search")} Perkirakan lokasi dari jejak ini</button>` : ""}
                </div>

                ${platforms.map(p => `
                    <div style="margin-top:12px;padding:10px;background:rgba(6,10,22,0.5);border-radius:var(--r-md)">
                        <div class="row" style="gap:8px">
                            <b>${esc(p.platform)}</b>
                            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noreferrer" class="small dim">${esc(p.url)}</a>` : ""}
                            <span class="small dim push">${p.comments?.length ?? 0} komentar</span>
                        </div>
                        ${p.note ? `<div class="small dim" style="margin-top:4px">${esc(p.note)}</div>` : ""}
                        ${(p.comments ?? []).slice(0, 5).map(k => `
                            <div class="small" style="margin:6px 0;padding:7px 9px;background:rgba(255,255,255,0.03);border-radius:4px">
                                <div>${esc(k.text)}</div>
                                <div class="dim" style="margin-top:3px;font-size:10.5px">
                                    ${k.at ? esc(String(k.at).slice(0, 10)) : ""}
                                    ${k.context ? ` · ${esc(k.context)}` : ""}
                                    ${k.url ? ` · <a href="${esc(k.url)}" target="_blank" rel="noreferrer">buka</a>` : ""}
                                </div>
                            </div>`).join("")}
                    </div>`).join("")}

                <div id="si-loc-from-trace" style="margin-top:12px"></div>
            </div>`;

        // Estimasi lokasi adalah LANJUTAN jejak ini, bukan alur
        // terpisah yang menyuruh menempel ulang postingan.
        out.querySelector("[data-loc-trace]")?.addEventListener("click", async ev => {
            const box = out.querySelector("#si-loc-from-trace");
            box.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Memperkirakan lokasi…</span></div>`;
            try {
                const loc = await api.osintSocialLocation({ trace_id: ev.currentTarget.dataset.locTrace });
                box.innerHTML = `
                    <div class="osint-block">
                        <div class="ttl">${icon("home")} Perkiraan lokasi</div>
                        <div class="line"><b>${esc(loc.country ?? "belum bisa ditentukan")}</b>
                            ${loc.timezone ? ` · ${esc(loc.timezone)}` : ""}
                            ${loc.confidence ? ` · keyakinan ${esc(loc.confidence)}` : ""}</div>
                        <div class="line dim">dari ${loc.basedOn?.comments ?? 0} komentar${
                            loc.basedOn?.statedLocation ? `, lokasi di profil: ${esc(loc.basedOn.statedLocation)}` : ""}</div>
                        ${(loc.indicators ?? []).map(i => `<div class="line">• ${esc(i)}</div>`).join("")}
                    </div>`;
            }
            catch (e) { box.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
        });
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function runLocationEstimate(host) {
    const username = host.querySelector("#si-loc-user").value.trim();
    if (!username) return toast("Isi username.", "warn");

    const postsText = host.querySelector("#si-loc-posts").value.trim();
    const posts = postsText.split("\n").filter(Boolean).map(line => {
        const m = line.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
        return m ? { timestamp: `2024-01-01T${m[1].padStart(2, "0")}:${m[2]}:00Z`, text: m[3] } : null;
    }).filter(Boolean);

    const out = host.querySelector("#si-loc-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Mengestimasi…</span></div>`;

    try {
        const r = await api.osintSocialLocation({
            username,
            location: host.querySelector("#si-loc-profile").value.trim() || undefined,
            posts: posts.length ? posts : undefined
        });

        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px">
                <div class="row" style="align-items:center;gap:10px">
                    ${pill(r.estimated ? "Terdeteksi" : "Tidak diketahui", r.estimated ? "ok" : "idle")}
                    <span class="small muted">confidence: ${esc(r.confidence)}</span>
                </div>
                ${r.country ? `
                    <div class="grid cols-2" style="gap:10px;margin-top:12px">
                        <div><div class="small dim">Negara</div><div class="small">${esc(r.country)}</div></div>
                        <div><div class="small dim">Zona waktu</div><div class="small">${esc(r.timezone ?? "—")}</div></div>
                        <div><div class="small dim">Bahasa</div><div class="small">${esc(r.language ?? "—")}</div></div>
                    </div>` : ""}
                ${r.indicators.length ? `
                    <div style="margin-top:12px">
                        <div class="small dim" style="margin-bottom:6px">Indikator:</div>
                        <ul class="small" style="margin:0;padding-left:18px">${r.indicators.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
                    </div>` : ""}
                <div class="small dim" style="margin-top:10px;font-style:italic">${esc(r.note)}</div>
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function runHoaxCheck(host) {
    const claim = host.querySelector("#si-hoax-claim").value.trim();
    if (!claim) return toast("Isi klaim/berita.", "warn");

    const out = host.querySelector("#si-hoax-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Mengecek fakta…</span></div>`;

    try {
        const r = await api.osintHoaxCheck(claim);
        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px;border-color:${r.hoax ? "rgba(255,84,112,0.4)" : "rgba(52,211,153,0.3)"}">
                <div class="row" style="align-items:center;gap:10px">
                    ${pill(r.hoax ? "HOAX" : "FAKTA", r.hoax ? "danger" : "ok")}
                    <span class="small muted">confidence: ${esc(r.confidence)}</span>
                </div>
                <div style="font:600 15px/1.3 var(--font-hud);margin-top:10px;color:${r.hoax ? "var(--danger)" : "var(--ok)"}">
                    ${esc(r.verdict)}
                </div>
                ${r.title ? `<div class="small" style="margin-top:8px"><b>${esc(r.title)}</b></div>` : ""}
                <div class="small" style="margin-top:10px">${esc(r.explanation)}</div>
                ${r.source_url ? `<div class="small dim" style="margin-top:6px">
                    Dibaca dari <a href="${esc(r.source_url)}" target="_blank" rel="noreferrer">${esc(r.source_url)}</a>
                    (${r.extractedChars} karakter)</div>` : ""}
                ${r.source ? `<div class="small dim" style="margin-top:8px">Sumber: ${esc(r.source)}</div>` : ""}
                ${r.warning ? `<div class="small" style="margin-top:8px;color:var(--warn)">${esc(r.warning)}</div>` : ""}
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}

async function runHoaxTrace(host) {
    const claim = host.querySelector("#si-hoax-claim").value.trim();
    if (!claim) return toast("Isi klaim/berita.", "warn");

    const out = host.querySelector("#si-hoax-result");
    out.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Melacak penyebar… (mungkin butuh 20-40 detik)</span></div>`;

    try {
        const r = await api.osintHoaxTrace(claim);
        out.innerHTML = `
            <div class="divider"></div>
            <div class="card" style="padding:16px">
                <div class="row" style="align-items:center;gap:10px">
                    ${pill(r.total_spreaders > 0 ? "Ditemukan" : "Tidak ditemukan", r.total_spreaders > 0 ? "warn" : "idle")}
                    <span class="small muted">${esc(r.summary)}</span>
                </div>
                ${r.keywords && r.keywords.length ? `
                    <div style="margin-top:10px">
                        <div class="small dim">Kata kunci:</div>
                        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
                            ${r.keywords.map(k => `<span class="tag">${esc(k)}</span>`).join("")}
                        </div>
                    </div>` : ""}
                ${r.platforms && r.platforms.filter(p => p.found && p.spreaders && p.spreaders.length > 0).map(p => `
                    <div style="margin-top:12px;padding:10px;background:rgba(6,10,22,0.5);border-radius:var(--r-md)">
                        <b>${esc(p.name)}</b>
                        <div style="margin-top:6px">
                            ${(p.spreaders ?? []).map(s => `<span class="tag" style="margin:2px">${esc(s)}</span>`).join("")}
                        </div>
                    </div>
                `).join("")}
            </div>`;
    }
    catch (e) { out.innerHTML = `<div class="small danger-text">${esc(e.message)}</div>`; }
}
