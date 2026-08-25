const crypto = require("node:crypto");

const TerminalSession = require("./TerminalSession");
const shells = require("./shells");
const backends = require("./backends");
const store = require("./terminalStore");
const telemetry = require("../../services/telemetryService");

/**
 * TerminalRuntime — manajer sesi terminal persisten milik daemon.
 *
 * Hidup di daemon (bukan Electron): AI & pengguna berbagi pty yang
 * sama, sesi bertahan meski Console ditutup, jalan headless. Backend
 * pty dipilih via descriptor.target (local sekarang; Docker/SSH/Remote
 * menyusul tanpa mengubah manajer ini).
 *
 * Klasifikasi terminal:
 *   SYSTEM  — runtime inti (Docker/dll): tak bisa
 *             ditutup tanpa force, boleh auto-restart, nama tetap.
 *   PROJECT — terkait proyek/tugas; nama tetap.
 *   USER    — dibuka pengguna; bisa rename & ditutup bebas.
 */

const TYPES = ["SYSTEM", "PROJECT", "USER"];
const RESTART_POLICIES = ["never", "on-failure", "always"];

class TerminalRuntime {

    constructor() {
        this.sessions = new Map();
    }

    get available() {
        return backends.get("local").available;
    }

    start() {
        if (!this.available) {
            telemetry.info("[terminal] node-pty belum diinstall — runtime terminal nonaktif (npm install node-pty).");
        }
        return this;
    }

    stop() {
        this.persist();
        for (const s of this.sessions.values()) {
            try { s.kill(); } catch { /* abaikan */ }
        }
        this.sessions.clear();
    }

    // ---- Buat & registrasi ---------------------------------------

    create(opts = {}) {
        const target = opts.target || "local";
        const backend = backends.get(target);
        if (!backend.available) {
            throw new Error(`Backend terminal '${target}' tak tersedia (node-pty belum diinstall?).`);
        }

        const sh = shells.resolve(opts.shell);
        const type = TYPES.includes(String(opts.terminalType).toUpperCase())
            ? String(opts.terminalType).toUpperCase() : "USER";
        const cwd = opts.cwd || process.env.USERPROFILE || process.env.HOME || process.cwd();
        const cols = opts.cols || 120;
        const rows = opts.rows || 30;

        // Elevasi (Admin) opsional & best-effort: gsudo (Win) / sudo (POSIX).
        let shellPath = sh.path, shellArgs = sh.args, elevated = false;
        if (opts.elevated) {
            const e = shells.elevate(sh.path, sh.args);
            if (e) { shellPath = e.path; shellArgs = e.args; elevated = true; }
        }

        const descriptor = {
            id: "t_" + crypto.randomBytes(4).toString("hex"),
            owner: opts.owner || "user",
            purpose: opts.purpose ? String(opts.purpose).toLowerCase() : null,
            terminalType: type,
            createdBy: opts.createdBy || "user",           // "user" | "ai" | "system"
            restartPolicy: RESTART_POLICIES.includes(opts.restartPolicy) ? opts.restartPolicy : "never",
            persistent: opts.persistent ?? (type !== "USER"),
            target,
            shell: sh.id,
            elevated,
            createdAt: new Date().toISOString()
        };

        const pty = backend.spawn({
            shellPath, args: shellArgs, cwd, cols, rows,
            env: { ...process.env, ...(opts.env || {}) },
            useConpty: elevated ? true : undefined   // gsudo butuh ConPTY
        });

        const session = new TerminalSession({ descriptor, name: opts.name || sh.name, pty, cwd, cols, rows });
        session.on("exit", code => {
            telemetry.publish("terminal:exited", { id: descriptor.id, code });
            this._maybeRestart(session, code);
        });

        this.sessions.set(descriptor.id, session);
        telemetry.publish("terminal:created", {
            id: descriptor.id, type, purpose: descriptor.purpose, name: session.name
        });
        this.persist();
        return session.meta();
    }

    // ---- Query ----------------------------------------------------

    list() { return [...this.sessions.values()].map(s => s.meta()); }
    get(id) { return this.sessions.get(id) || null; }

    findByName(name) {
        const n = String(name || "").toLowerCase();
        return [...this.sessions.values()].find(s => s.name.toLowerCase() === n) || null;
    }

    /** Cari terminal berdasarkan PURPOSE (kunci reuse yang stabil). */
    findByPurpose(purpose) {
        const p = String(purpose || "").toLowerCase();
        if (!p) return null;
        return [...this.sessions.values()].find(s => s.descriptor.purpose === p) || null;
    }

    /** Cari-atau-buat berdasarkan purpose — jalur reuse utama untuk AI. */
    ensureByPurpose(opts = {}) {
        const existing = this.findByPurpose(opts.purpose);
        if (existing && existing.status === "running") return existing.meta();
        return this.create(opts);
    }

    // ---- I/O & kontrol -------------------------------------------

    write(id, data) { return this.req(id).write(data); }
    signal(id, name) { return this.req(id).signal(name); }
    resize(id, cols, rows) { const s = this.req(id); s.resize(cols, rows); return s.meta(); }
    read(id) { return this.req(id).read(); }
    execute(id, command, opts) { return this.req(id).execute(command, opts); }
    kill(id) { return this.req(id).kill(); }

    rename(id, name) {
        const s = this.req(id);
        if (s.terminalType !== "USER") {
            throw new Error(`Nama terminal ${s.terminalType} bersifat tetap — hanya terminal USER yang bisa di-rename.`);
        }
        s.name = name;
        this.persist();
        return s.meta();
    }

    /** Tutup tab. Terminal SYSTEM butuh force (anti-tutup tak sengaja). */
    close(id, { force = false } = {}) {
        const s = this.get(id);
        if (!s) return true;
        if (s.isSystem() && !force) {
            const err = new Error(`Terminal SYSTEM '${s.name}' tidak bisa ditutup tanpa force.`);
            err.code = "SYSTEM_PROTECTED";
            throw err;
        }
        try { s.kill(); } catch { /* abaikan */ }
        this.sessions.delete(id);
        this.persist();
        return true;
    }

    // ---- Restore & introspeksi -----------------------------------

    saved() { return store.read().terminals || []; }

    restore(id) {
        const meta = this.saved().find(t => t.id === id);
        if (!meta) throw new Error(`Terminal tersimpan '${id}' tidak ada.`);
        return this.create({
            shell: meta.shell, cwd: meta.cwd, name: meta.name,
            purpose: meta.purpose, owner: meta.owner, terminalType: meta.terminalType,
            createdBy: meta.createdBy, restartPolicy: meta.restartPolicy, persistent: meta.persistent
        });
    }

    availableShells() { return shells.detect().map(s => ({ id: s.id, name: s.name })); }
    backends() { return backends.list(); }

    // ---- internal -------------------------------------------------

    _maybeRestart(session, code) {
        const d = session.descriptor;
        // Hanya bila masih terdaftar (bukan ditutup) & kebijakan cocok.
        const should = this.sessions.has(d.id) && (
            d.restartPolicy === "always" ||
            (d.restartPolicy === "on-failure" && code !== 0)
        );
        if (!should) return;

        // Cap anti-loop: maks 3 restart dalam 60 detik.
        session._restarts = (session._restarts || []).filter(t => Date.now() - t < 60000);
        if (session._restarts.length >= 3) {
            telemetry.warn(`[terminal] ${d.id} (${session.name}) restart di-skip — loop terdeteksi.`);
            return;
        }
        session._restarts.push(Date.now());

        try {
            const sh = shells.resolve(d.shell);
            let shellPath = sh.path, shellArgs = sh.args;
            if (d.elevated) { const e = shells.elevate(sh.path, sh.args); if (e) { shellPath = e.path; shellArgs = e.args; } }
            const pty = backends.get(d.target).spawn({
                shellPath, args: shellArgs, cwd: session.cwd,
                cols: session.cols, rows: session.rows, env: { ...process.env },
                useConpty: d.elevated ? true : undefined
            });
            session.attach(pty);
            telemetry.publish("terminal:restarted", { id: d.id, name: session.name });
        }
        catch (error) {
            telemetry.warn(`[terminal] restart ${d.id} gagal: ${error.message}`);
        }
    }

    req(id) {
        const s = this.get(id);
        if (!s) throw new Error(`Terminal '${id}' tidak ada.`);
        return s;
    }

    persist() {
        store.write({
            terminals: this.list().map(m => ({
                id: m.id, name: m.name, purpose: m.purpose, owner: m.owner,
                terminalType: m.terminalType, createdBy: m.createdBy,
                restartPolicy: m.restartPolicy, persistent: m.persistent,
                target: m.target, shell: m.shell, cwd: m.cwd
            }))
        });
    }

}

module.exports = new TerminalRuntime();
