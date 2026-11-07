import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, bytes, pill, toast } from "../lib/ui.js";

/**
 * NAS — gaya DiskStation Manager (Synology). Data nyata dari daemon:
 * Storage Manager (pool + volume), App Center (Immich), SMART, Docker,
 * jaringan. Immich dipasang/dikelola dari sini; foto/video ke iPhone
 * lewat app Immich resmi.
 */
let lastIp = null;

export const nas = {

    id: "nas",
    label: "NAS",
    icon: "server",
    title: "NAS",
    subtitle: "DiskStation Damar — penyimpanan, aplikasi, dan kesehatan disk.",

    render(root) {
        root.innerHTML = `
            <div class="view-head">
                <div><h1>NAS</h1><p>DiskStation Damar — penyimpanan, aplikasi, dan kesehatan disk.</p></div>
                <div class="actions"><button class="btn ghost sm" id="nas-refresh">${icon("refresh")} Muat ulang</button></div>
            </div>
            <div id="nas-body" class="stack"></div>`;
    },

    async mount(root) {
        const load = () => draw(root);
        root.querySelector("#nas-refresh").addEventListener("click", load);
        await load();
    }

};

async function draw(root) {
    const body = root.querySelector("#nas-body");
    body.innerHTML = `<div class="panel"><div class="row"><span class="spinner"></span><span class="small muted">Membaca DiskStation…</span></div></div>`;

    let s, immich, cfg, pools, backups;
    try {
        [s, immich, cfg, pools, backups] = await Promise.all([
            api.nasStatus(),
            api.immichStatus().catch(() => null),
            api.nasConfig().catch(() => ({ pool: null })),
            api.nasPools().catch(() => null),
            api.backups().catch(() => ({ jobs: [] }))
        ]);
    }
    catch (e) { body.innerHTML = `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(e.message)}</div></div></div>`; return; }

    lastIp = s.network[0]?.address ?? "IP-PC";
    const pool = cfg?.pool ?? s.pool ?? null;

    body.innerHTML = `
        ${heroPanel(s, pool, immich)}

        <div class="grid cols-2">
            ${storagePanel(s, pool)}
            ${appCenter(immich, pool)}
        </div>

        ${raidPanel(pools)}

        ${backupPanel(backups, pool)}

        ${notifyPanel(cfg)}

        <div class="grid cols-2">
            <div class="panel">
                <div class="panel-head"><h2>${icon("cpu")} Kesehatan Disk (SMART)</h2></div>
                ${smartPanel(s.smart)}
            </div>
            <div class="panel">
                <div class="panel-head"><h2>${icon("link")} Jaringan</h2></div>
                ${s.network.length
                    ? s.network.map(n => `<div class="list-item"><div style="flex:1"><div class="title">${esc(n.name)}</div><div class="sub mono">${esc(n.mac ?? "")}</div></div><span class="tag mono">${esc(n.address)}</span></div>`).join("")
                    : `<div class="empty">${icon("link")}<div>Tak ada antarmuka aktif.</div></div>`}
            </div>
        </div>

        ${smbPanel(s, pool)}

        <div class="panel">
            <div class="panel-head"><h2>${icon("terminal")} Docker Containers</h2>
                <span class="hint push">${s.docker.available ? s.docker.containers.length : "—"}</span></div>
            ${dockerPanel(s.docker)}
        </div>`;

    wire(root, s);
}

function storagePanel(s, pool) {
    return `
        <div class="panel">
            <div class="panel-head"><h2>${icon("box")} Storage Manager</h2><span class="hint push">${s.volumes.length} volume</span></div>
            <div class="field" style="margin-bottom:12px">
                <label>Disk untuk penyimpanan NAS (Storage Pool)</label>
                <div class="row" style="gap:8px">
                    <select id="nas-pool-vol" style="flex:1">
                        <option value="">— pilih disk —</option>
                        ${s.volumes.map(v => `<option value="${esc(v.mount)}">${esc(v.mount)} ${v.label ? `(${esc(v.label)})` : ""} · ${bytes(v.free)} bebas</option>`).join("")}
                    </select>
                    <button class="btn primary sm" id="nas-pool-set">${icon("check")} Jadikan Pool</button>
                </div>
                <span class="help">${pool ? `Pool aktif: <span class="mono">${esc(pool)}</span>` : "Belum ada pool. Pilih disk (mis. D:) — data NAS & Immich disimpan di sana."}</span>
            </div>
            ${s.volumes.length === 0
                ? `<div class="empty">${icon("box")}<div>Tak ada volume terbaca.</div></div>`
                : s.volumes.map(v => volRow(v, s.poolMount)).join("")}
        </div>`;
}

function appCenter(immich, pool) {
    const av = immich?.available;
    const running = immich?.running > 0;
    const tone = !av ? "idle" : running ? "ok" : "warn";
    const state = !av ? "Docker tak aktif" : running ? "Berjalan" : (immich.installed ? "Terpasang, mati" : "Belum dipasang");
    return `
        <div class="panel">
            <div class="panel-head"><h2>${icon("box")} App Center</h2></div>
            <div class="panel agent-card" style="background:var(--bg-inset)">
                <div class="top">
                    <span class="tile">${icon("camera")}</span>
                    <div style="flex:1;min-width:0">
                        <div class="row" style="gap:8px"><span class="nm">Immich</span> ${pill(state, tone)}</div>
                        <div class="rl">Backup foto &amp; video pribadi</div>
                    </div>
                </div>
                <div class="desc">Galeri mandiri seperti Google Photos, tapi di NAS-mu sendiri. Foto/video dari iPhone tersimpan otomatis.</div>
                ${!pool ? `<div class="small warn-text">${icon("alert")} Pilih Storage Pool dulu di Storage Manager.</div>` : ""}
                ${av ? `<div class="small dim">Data: <span class="mono">${esc(immich.dataRoot)}</span></div>` : `<div class="small dim">${esc(immich?.reason ?? "Docker belum tersedia di mesin ini.")}</div>`}
                <div class="row" style="gap:8px;flex-wrap:wrap">
                    <button class="btn primary sm" id="immich-up" ${!pool ? "disabled" : ""}>${icon("play")} ${immich?.installed ? "Nyalakan" : "Pasang & Nyalakan"}</button>
                    <button class="btn ghost sm" id="immich-down" ${immich?.installed ? "" : "disabled"}>${icon("stop")} Matikan</button>
                    <button class="btn ghost sm" id="immich-open">${icon("link")} Buka Immich</button>
                </div>
            </div>
            <div class="divider"></div>
            <div class="small">
                <div style="font-weight:600;margin-bottom:4px">${icon("chat")} Sambungkan iPhone</div>
                <div class="dim">1. Install app <strong>Immich</strong> dari App Store.
                2. Server URL: <span class="mono">http://${esc(lastIp)}:2283</span>.
                3. Login, aktifkan <em>Backup</em> → foto &amp; video otomatis masuk NAS.</div>
            </div>
        </div>`;
}

function raidPanel(pools) {
    if (!pools || !pools.supported) {
        return `<div class="panel"><div class="panel-head"><h2>${icon("box")} Storage Pool (RAID / Storage Spaces)</h2></div>
            <div class="small dim">Hanya di Windows. Storage Spaces menggabungkan 2+ disk jadi satu volume tahan-gagal.</div></div>`;
    }
    const cmd = `powershell -ExecutionPolicy Bypass -File deploy\\nas\\create-storage-space.ps1 -Resiliency Mirror -DriveLetter N`;
    return `
        <div class="panel">
            <div class="panel-head"><h2>${icon("box")} Storage Pool (RAID / Storage Spaces)</h2>
                <span class="hint push">${pools.pools.length} pool · ${pools.candidates.length} disk siap</span></div>

            ${pools.pools.length
                ? `<div class="scroll-x"><table class="table">
                    <thead><tr><th>Volume</th><th>Resiliency</th><th>Ukuran</th><th>Kesehatan</th></tr></thead>
                    <tbody>${pools.pools.map(p => `<tr>
                        <td>${esc(p.name)}</td>
                        <td>${pill(esc(p.resiliency || "—"), "idle")}</td>
                        <td class="mono small">${p.sizeGB ? p.sizeGB + " GB" : "—"}</td>
                        <td>${pill(esc(p.health || "?"), p.health === "Healthy" ? "ok" : "warn")}</td>
                    </tr>`).join("")}</tbody></table></div>`
                : `<div class="small dim">Belum ada Storage Pool.</div>`}

            <div class="divider"></div>
            <div class="small" style="margin-bottom:6px">
                <strong>Disk yang bisa di-pool:</strong>
                ${pools.candidates.length
                    ? pools.candidates.map(d => `<span class="tag">${esc(d.name)} · ${d.sizeGB} GB${d.media ? " · " + esc(d.media) : ""}</span>`).join(" ")
                    : `<span class="dim">tak ada (disk harus kosong/tak berpartisi)</span>`}
            </div>
            <div class="small warn-text" style="margin:6px 0">${icon("alert")} Membuat pool MENGHAPUS seluruh data di disk terpilih. Jalankan sebagai Administrator di PC rumah:</div>
            <div class="code-view" id="raid-cmd">${esc(cmd)}</div>
            <button class="btn sm" id="raid-copy" style="margin-top:8px">${icon("copy")} Salin perintah</button>
        </div>`;
}

function backupPanel(data, pool) {
    const list = data?.jobs ?? [];
    const defDest = pool ? `${pool}\\backup` : "D:\\DamarNAS\\backup";
    return `
        <div class="panel">
            <div class="panel-head"><h2>${icon("refresh")} Backup Terjadwal</h2>
                <span class="hint push">${list.length} job</span></div>
            <p class="small dim" style="margin:-6px 0 12px">Salinan berkala folder → NAS. Aman: hanya menambah/menimpa, tak pernah menghapus di tujuan.</p>

            ${list.length ? `<div class="scroll-x"><table class="table">
                <thead><tr><th>Nama</th><th>Sumber → Tujuan</th><th>Tiap</th><th>Terakhir</th><th style="width:1%"></th></tr></thead>
                <tbody>${list.map(j => `<tr data-job="${esc(j.id)}">
                    <td>${esc(j.name)}</td>
                    <td class="mono small truncate" style="max-width:340px">${esc(j.source)} → ${esc(j.dest)}</td>
                    <td class="small">${esc(j.intervalHours)} jam</td>
                    <td>${j.lastRun ? pill(esc(j.lastStatus ?? "?"), j.lastStatus === "ok" ? "ok" : "danger") : `<span class="small dim">belum</span>`}</td>
                    <td><div class="row" style="gap:4px">
                        <button class="btn sm" data-run>${icon("play")}</button>
                        <button class="btn sm danger" data-del>${icon("trash")}</button>
                    </div></td>
                </tr>`).join("")}</tbody></table></div><div class="divider"></div>` : ""}

            <div class="grid cols-4" style="gap:8px;align-items:end">
                <div class="field"><label>Nama</label><input type="text" id="bk-name" placeholder="Foto HP"></div>
                <div class="field" style="grid-column:span 2"><label>Folder sumber</label><input type="text" id="bk-src" class="mono" placeholder="C:\\Users\\..\\Pictures"></div>
                <div class="field"><label>Tiap (jam)</label><input type="number" id="bk-int" value="24" min="1"></div>
                <div class="field" style="grid-column:span 3"><label>Folder tujuan (di NAS)</label><input type="text" id="bk-dst" class="mono" value="${esc(defDest)}"></div>
                <div><button class="btn primary" id="bk-add" style="width:100%">${icon("plus")} Tambah</button></div>
            </div>
        </div>`;
}

function notifyPanel(cfg) {
    const q = cfg?.quotaPercent ?? 90;
    return `
        <div class="panel">
            <div class="panel-head"><h2>${icon("activity")} Notifikasi &amp; Peringatan Disk</h2></div>
            <div class="small dim" style="margin-bottom:10px">
                Hasil backup dan peringatan disk dikirim otomatis ke WhatsApp (nomor pemilik yang diizinkan di Settings).
            </div>
            <div class="grid cols-3" style="gap:10px;align-items:end">
                <div class="field">
                    <label>Ambang kuota disk (%)</label>
                    <input type="number" id="nas-quota" min="50" max="99" value="${esc(q)}">
                    <span class="help">Peringatan bila pemakaian volume melewati ini.</span>
                </div>
                <div><button class="btn primary sm" id="nas-quota-save" style="width:100%">${icon("check")} Simpan</button></div>
                <div class="row" style="gap:8px">
                    <button class="btn ghost sm" id="nas-notify-test">${icon("chat")} Uji WA</button>
                    <button class="btn ghost sm" id="nas-monitor-now">${icon("refresh")} Cek sekarang</button>
                </div>
            </div>
        </div>`;
}

function smbPanel(s, pool) {
    const sh = s.smb || {};
    const cmd = `powershell -ExecutionPolicy Bypass -File deploy\\nas\\share-smb.ps1 -Pool "${pool || "D:\\DamarNAS"}"`;
    return `
        <div class="panel">
            <div class="panel-head"><h2>${icon("folder")} Akses File (SMB) — iPhone &amp; perangkat lain</h2>
                <span class="push">${pill(sh.shared ? "Aktif" : "Belum aktif", sh.shared ? "ok" : "idle")}</span></div>
            ${sh.shared
                ? `<div class="small">Share aktif: <span class="mono">\\\\${esc(lastIp)}\\${esc(sh.name)}</span> → <span class="mono">${esc(sh.path || pool || "")}</span></div>`
                : `<div class="small dim" style="margin-bottom:6px">Jalankan sekali sebagai <strong>Administrator</strong> di PC rumah untuk mengaktifkan share:</div>
                   <div class="code-view" id="smb-cmd">${esc(cmd)}</div>
                   <button class="btn sm" id="smb-copy" style="margin-top:8px">${icon("copy")} Salin perintah</button>`}
            <div class="divider"></div>
            <div class="small">
                <div style="font-weight:600;margin-bottom:4px">${icon("chat")} Dari iPhone (tanpa app tambahan)</div>
                <div class="dim">App <strong>Files</strong> → titik-tiga (…) → <em>Connect to Server</em> →
                    <span class="mono">smb://${esc(lastIp)}/${esc(sh.name || "DamarNAS")}</span> → login akun Windows.</div>
            </div>
        </div>`;
}

function smartPanel(smart) {
    if (!smart.available) return `<div class="empty">${icon("alert")}<div>${esc(smart.reason)}</div></div>`;
    if (!smart.devices.length) return `<div class="empty">${icon("cpu")}<div>Tak ada disk SMART terdeteksi.</div></div>`;
    return `<div class="scroll-x"><table class="table">
        <thead><tr><th>Device</th><th>Model</th><th>Health</th><th>Suhu</th><th>Kapasitas</th></tr></thead>
        <tbody>${smart.devices.map(d => `<tr>
            <td class="mono small">${esc(d.device)}</td><td class="small">${esc(d.model ?? "—")}</td>
            <td>${pill(d.health, d.health === "PASSED" ? "ok" : d.health === "FAILED" ? "danger" : "idle")}</td>
            <td class="mono small">${d.tempC != null ? d.tempC + "°C" : "—"}</td>
            <td class="mono small">${d.capacity ? bytes(d.capacity) : "—"}</td>
        </tr>`).join("")}</tbody></table></div>`;
}

function dockerPanel(docker) {
    if (!docker.available) return `<div class="empty">${icon("alert")}<div>${esc(docker.reason)}</div></div>`;
    if (!docker.containers.length) return `<div class="empty">${icon("terminal")}<div>Tak ada container berjalan.</div></div>`;
    return `<div class="scroll-x"><table class="table">
        <thead><tr><th>Nama</th><th>Image</th><th>Status</th></tr></thead>
        <tbody>${docker.containers.map(c => `<tr>
            <td>${esc(c.name)}</td><td class="mono small">${esc(c.image)}</td>
            <td>${pill(esc(c.status), /up/i.test(c.status) ? "ok" : "idle")}</td>
        </tr>`).join("")}</tbody></table></div>`;
}

function volRow(v, poolMount) {
    const tone = v.usedPercent >= 90 ? "var(--danger)" : v.usedPercent >= 75 ? "var(--warn)" : "var(--accent-1)";
    const isPool = poolMount && v.mount.toUpperCase() === poolMount.toUpperCase();
    return `
        <div style="padding:10px 2px">
            <div class="row" style="gap:10px;margin-bottom:6px">
                <span class="tile" style="width:30px;height:30px">${icon("box")}</span>
                <div style="flex:1;min-width:0">
                    <div class="title">${esc(v.mount)} ${v.label ? `<span class="small dim">${esc(v.label)}</span>` : ""} ${isPool ? pill("Pool NAS", "ok") : ""}</div>
                    <div class="sub">${bytes(v.used)} / ${bytes(v.total)} · ${bytes(v.free)} bebas${v.fs ? ` · ${esc(v.fs)}` : ""}</div>
                </div>
                <span class="mono" style="font-size:15px;color:${tone}">${v.usedPercent}%</span>
            </div>
            <div class="progress"><div class="bar" style="width:${v.usedPercent}%;background:${tone}"></div></div>
        </div>`;
}

/** Hero sci-fi: ring kapasitas storage + statistik kunci. */
function heroPanel(s, pool, immich) {
    const vols = s.volumes ?? [];
    const used = vols.reduce((a, v) => a + (v.used || 0), 0);
    const total = vols.reduce((a, v) => a + (v.total || 0), 0);
    const free = Math.max(0, total - used);
    const pct = total ? Math.round(used / total * 100) : 0;
    const tone = pct >= 90 ? "var(--danger,#ff6b6b)" : pct >= 75 ? "var(--warn,#ffb300)" : "var(--neon-cyan,#35d6f0)";
    const disks = s.smart?.available ? s.smart.devices.length : 0;

    return `
    <div class="nas-hero">
        <div class="nas-ring" style="--pct:${pct};--tone:${tone}">
            <div class="nas-ring-in">
                <div class="nas-ring-pct">${pct}<span>%</span></div>
                <div class="nas-ring-lab">terpakai</div>
            </div>
        </div>
        <div class="nas-hero-stats">
            <div class="nas-stat"><span class="k">${icon("server")} DiskStation</span><span class="v">${esc(s.host)}</span><span class="s">${esc(s.platform ?? "")}</span></div>
            <div class="nas-stat"><span class="k">${icon("box")} Kapasitas</span><span class="v">${bytes(free)} bebas</span><span class="s">${bytes(used)} / ${bytes(total)}</span></div>
            <div class="nas-stat"><span class="k">${icon("cpu")} Disk</span><span class="v">${disks} disk</span><span class="s">${s.smart?.available ? "SMART sehat" : "SMART n/a"}</span></div>
            <div class="nas-stat"><span class="k">${icon("box")} Volume</span><span class="v">${vols.length}</span><span class="s">${pool ? esc(pool) : "pool belum diatur"}</span></div>
            <div class="nas-stat"><span class="k">${icon("terminal")} Immich</span><span class="v">${immich?.available ? (immich.running ? "aktif" : "siap") : "n/a"}</span><span class="s">${immich?.available ? `${immich.running} layanan` : "docker absen"}</span></div>
        </div>
    </div>`;
}

function metric(iconName, label, value, sub) {
    return `<div class="metric"><div class="k">${icon(iconName)} ${esc(label)}</div>
        <div class="v" style="font-size:18px">${value}</div><div class="s">${esc(sub ?? "")}</div></div>`;
}

function wire(root, s) {
    root.querySelector("#nas-pool-set")?.addEventListener("click", async () => {
        const mount = root.querySelector("#nas-pool-vol").value;
        if (!mount) return toast("Pilih disk dulu.", "warn");
        const sep = mount.endsWith(":") ? "\\" : (mount.includes("\\") ? "\\" : "/");
        const pool = `${mount}${sep}DamarNAS`;
        try { await api.nasSetConfig(pool); toast(`Pool NAS: ${pool}`, "ok"); draw(root); }
        catch (e) { toast(e.message, "danger"); }
    });

    root.querySelector("#immich-up")?.addEventListener("click", async () => {
        try { const r = await api.immichUp(); toast(r.note ?? "Immich dinyalakan", "ok", 6000); setTimeout(() => draw(root), 3000); }
        catch (e) { toast(e.message, "danger"); }
    });
    root.querySelector("#immich-down")?.addEventListener("click", async () => {
        try { await api.immichDown(); toast("Immich dimatikan", "ok"); draw(root); }
        catch (e) { toast(e.message, "danger"); }
    });
    root.querySelector("#immich-open")?.addEventListener("click", () => {
        window.open(`http://${lastIp}:2283`, "_blank");
    });

    root.querySelector("#smb-copy")?.addEventListener("click", () => {
        const cmd = root.querySelector("#smb-cmd")?.textContent ?? "";
        navigator.clipboard.writeText(cmd).then(() => toast("Perintah disalin", "ok"));
    });

    root.querySelector("#raid-copy")?.addEventListener("click", () => {
        const cmd = root.querySelector("#raid-cmd")?.textContent ?? "";
        navigator.clipboard.writeText(cmd).then(() => toast("Perintah disalin", "ok"));
    });

    // Notifikasi & pemantau disk
    root.querySelector("#nas-quota-save")?.addEventListener("click", async () => {
        const quotaPercent = Number(root.querySelector("#nas-quota").value) || 90;
        try { await api.nasSetConfig(undefined, quotaPercent); toast(`Ambang kuota: ${quotaPercent}%`, "ok"); }
        catch (e) { toast(e.message, "danger"); }
    });
    root.querySelector("#nas-notify-test")?.addEventListener("click", async () => {
        try { const r = await api.nasTestNotify(); toast(r.sent > 0 ? `Terkirim ke ${r.sent} nomor` : "Tak ada nomor WA aktif", r.sent > 0 ? "ok" : "warn"); }
        catch (e) { toast(e.message, "danger"); }
    });
    root.querySelector("#nas-monitor-now")?.addEventListener("click", async () => {
        try { const r = await api.nasMonitorCheck(); toast(`Dicek — ${r.issues ?? 0} masalah, ${r.alerted ?? 0} peringatan dikirim`, "ok"); }
        catch (e) { toast(e.message, "danger"); }
    });

    // Backup
    root.querySelector("#bk-add")?.addEventListener("click", async () => {
        const job = {
            name: root.querySelector("#bk-name").value.trim(),
            source: root.querySelector("#bk-src").value.trim(),
            dest: root.querySelector("#bk-dst").value.trim(),
            intervalHours: Number(root.querySelector("#bk-int").value) || 24
        };
        if (!job.source || !job.dest) return toast("Folder sumber & tujuan wajib diisi.", "warn");
        try { await api.backupAdd(job); toast("Job backup dibuat", "ok"); draw(root); }
        catch (e) { toast(e.message, "danger"); }
    });
    root.querySelectorAll("[data-job]").forEach(tr => {
        const id = tr.dataset.job;
        tr.querySelector("[data-run]")?.addEventListener("click", async () => {
            toast("Menjalankan backup…", "ok");
            try { const r = await api.backupRun(id); toast(`Backup ${r.status} (exit ${r.code})`, r.status === "ok" ? "ok" : "danger"); draw(root); }
            catch (e) { toast(e.message, "danger"); }
        });
        tr.querySelector("[data-del]")?.addEventListener("click", async () => {
            if (!window.confirm("Hapus job backup ini?")) return;
            try { await api.backupRemove(id); draw(root); }
            catch (e) { toast(e.message, "danger"); }
        });
    });
}
