import * as THREE from "../../vendor/three.module.js";

/**
 * SWARM ORB AGEN — 12 orb kecil "bersemanyam" di sekitar orb utama.
 *
 * Tiap orb mewakili satu agent (openclaw, hermes + 10 anak buah):
 *   - BEBAS   : mengambang pelan mengorbit orb utama dengan lintasan
 *               unik (warna khas agent), berkilau tenang.
 *   - ENERGI  : saat agent DIPAKAI (step:start), orb-nya terbang
 *               mendekat ke permukaan orb utama, membesar & memerah
 *               terang, lalu MENYALURKAN PARTIKEL ENERGI — aliran orb
 *               kecil yang mengalir dari orb agent ke orb utama.
 *   - HASIL   : saat langkah selesai (step:done), orb melepaskan
 *               diri kembali bebas sambil MENEBAKAN warna hasil —
 *               hijau (sukses) / merah (gagal) — sebelum kembali ke
 *               warna khasnya.
 *
 * Orb utama sendiri TIDAK digambar di sini — modul ini hanya lapisan
 * "kehadiran" di sekitar entitas inti (scene yang sama, group ini
 * ditambahkan ke root entitas).
 */

// Definisi agent: warna hex khas masing-masing.
export const AGENT_DEFS = [
    { id: "openclaw", label: "OpenClaw", hex: 0xFF7A59 },   // karang — tangan digital
    { id: "hermes",   label: "Hermes",   hex: 0xB892FF },   // ungu muda — runtime agen
    { id: "vanta",    label: "Vanta",    hex: 0x5ED3F3 },   // biru es — riset
    { id: "forge",    label: "Forge",    hex: 0xFFA23E },   // jingga — coding
    { id: "nexus",    label: "Nexus",    hex: 0x6BF2A8 },   // hijau neon — sistem
    { id: "sera",     label: "Sera",     hex: 0xFF8FD2 },   // merah muda — vision
    { id: "echo",     label: "Echo",     hex: 0x7FD4FF },   // biru muda — suara
    { id: "cipher",   label: "Cipher",   hex: 0x9AA7FF },   // indigo — keamanan
    { id: "atlas",    label: "Atlas",    hex: 0xFFD166 },   // kuning — otomatisasi
    { id: "mira",     label: "Mira",     hex: 0xFFB3C7 },   // rose — memori
    { id: "pulse",    label: "Pulse",    hex: 0x4EE6C4 },   // toska — monitoring
    { id: "lumen",    label: "Lumen",    hex: 0xC7F584 }    // lime — antarmuka
];

const OK_HEX = 0x21E6A4;    // hijau sukses
const FAIL_HEX = 0xFF3B3B;  // merah gagal
const WHITE = 0xE8FCFF;

// Radius orb utama (swarm inti entity ±1.32) & jarak orbit agen.
const CORE_R = 2.15;                            // orb utama membesar (Siri)
const ORBIT_MIN = 3.1, ORBIT_MAX = 4.6;         // orbit agen ikut menjauh
const ENGAGE_DIST = CORE_R + 0.5;   // menempel dekat permukaan

function dotTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.3, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.65, "rgba(255,255,255,0.28)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/**
 * @param {object} opts
 * @param {THREE.Group} opts.root      group root entitas (orb utama)
 * @param {() => number} opts.excite   antusiasme global (0..~1.8)
 */
export function createAgentSwarm({ root, excite = () => 0 } = {}) {

    const tex = dotTexture();
    const group = new THREE.Group();
    root.add(group);

    const tmpC = new THREE.Color();
    const okC = new THREE.Color(OK_HEX);
    const failC = new THREE.Color(FAIL_HEX);
    const whiteC = new THREE.Color(WHITE);

    // ------------------------------------------------------------
    // SATU ORB AGEN — bola kecil dari ~90 orb cahaya + halo energi
    // ------------------------------------------------------------
    const ORB_PTS = 90;

    const orbs = AGENT_DEFS.map((def, idx) => {

        const mesh = mkPoints(ORB_PTS, 0.052, 0.9);
        group.add(mesh);

        // Lintasan bebas unik: radius, inklinasi, fasa, kecepatan.
        const seed = {
            baseR: ORBIT_MIN + Math.random() * (ORBIT_MAX - ORBIT_MIN),
            incl: (idx / AGENT_DEFS.length) * Math.PI + Math.random() * 0.5,
            node: Math.random() * Math.PI * 2,
            th0: Math.random() * Math.PI * 2,
            spd: 0.05 + Math.random() * 0.09,
            bobAmp: 0.16 + Math.random() * 0.22,
            bobSpd: 0.5 + Math.random() * 0.7,
            phase: Math.random() * Math.PI * 2
        };

        // Keadaan dinamis orb.
        const st = {
            mode: "free",            // free | engage | release
            t: 0,                    // progres transisi
            pos: new THREE.Vector3(),
            flash: 0,                // intensitas ledakan warna hasil
            flashOK: true,
            glow: 0                  // denyut cahaya saat menyalurkan
        };

        return { def, mesh, seed, st };

    });

    function mkPoints(count, size, opacity) {
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const col = new Float32Array(count * 3);
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({
            size, map: tex, vertexColors: true, transparent: true, opacity,
            sizeAttenuation: true, depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const pts = new THREE.Points(geo, mat);
        pts.userData = { pos, col, count };
        return pts;
    }

    // Posisi bebas orb (orbit miring unik + anggun naik-turun).
    function freePos(seed, t, out) {
        const th = seed.th0 + t * seed.spd;
        const r = seed.baseR + Math.sin(t * 0.23 + seed.phase) * 0.3;
        const x = Math.cos(th) * r;
        const z = Math.sin(th) * r;
        // Inklinasi: bidang orbit dimiringkan per agen.
        const y = Math.sin(th + seed.node) * Math.sin(seed.incl) * r * 0.5
            + Math.sin(t * seed.bobSpd + seed.phase) * seed.bobAmp;
        out.set(x, y, z);
        return out;
    }

    // Posisi menempel orb utama (titik dok dekat permukaan).
    function engagePos(seed, t, out) {
        const th = seed.th0 + t * seed.spd * 0.35;
        const y = Math.sin(th + seed.node) * Math.sin(seed.incl) * ENGAGE_DIST * 0.5;
        out.set(
            Math.cos(th) * ENGAGE_DIST,
            y,
            Math.sin(th) * ENGAGE_DIST
        );
        return out;
    }

    // ------------------------------------------------------------
    // ALIRAN ENERGI — partikel mengalir dari orb agen → orb utama
    // ------------------------------------------------------------
    const FLOW_N = 360;
    const flow = mkPoints(FLOW_N, 0.06, 0.95);
    group.add(flow);
    // seed aliran: index orb pemilik, umur, umur-total
    const flowSeed = new Float32Array(FLOW_N * 2);
    resetFlow(flowSeed, 0);

    function resetFlow(seedArr, owner) {
        for (let i = 0; i < FLOW_N; i++) {
            seedArr[i * 2] = owner;                                  // diganti saat lahir
            seedArr[i * 2 + 1] = Math.random();                      // umur 0..1
        }
    }
    resetFlow(flowSeed, -1);
    // Tandai semua mati.
    const flowAlive = new Float32Array(FLOW_N).fill(0);
    let flowCursor = 0;

    function spawnFlow(owner, n) {
        for (let k = 0; k < n; k++) {
            const i = flowCursor++ % FLOW_N;
            flowSeed[i * 2] = owner;
            flowSeed[i * 2 + 1] = 0;
            flowAlive[i] = 1;
        }
    }

    // ------------------------------------------------------------
    // API — dipanggil agentBus
    // ------------------------------------------------------------

    /** Agent mulai bekerja: orb terbang mendekat. */
    function engage(id) {
        const orb = orbs.find(o => o.def.id === id);
        if (!orb || orb.st.mode === "engage") return;
        orb.st.mode = "engage";
        orb.st.t = 0;
        orb.st.glow = 0;
    }

    /** Langkah selesai: orb lepas + ledakan warna hasil. */
    function release(id, ok = true) {
        const orb = orbs.find(o => o.def.id === id);
        if (!orb) return;
        orb.st.mode = "release";
        orb.st.t = 0;
        orb.st.flash = 1;
        orb.st.flashOK = ok;
        // Hujan energi penutup: partikel terakhir menyembur ke inti.
        spawnFlow(orbs.indexOf(orb), ok ? 46 : 22);
    }

    // ------------------------------------------------------------
    // LOOP ANIMASI — dipanggil dari tick entity utama
    // ------------------------------------------------------------

    function update(dt, t) {

        const ex = excite();

        for (const orb of orbs) {

            const { mesh, seed, st, def } = orb;
            const { pos, col, count } = mesh.userData;
            const baseC = tmpC.setHex(def.hex);

            // --- transisi mode ---
            if (st.mode === "engage") {
                st.t = Math.min(1, st.t + dt * 1.4);
                st.glow = Math.min(1, st.glow + dt * 2.2);
            }
            else if (st.mode === "release") {
                st.t = Math.min(1, st.t + dt * 0.85);
                if (st.t >= 1) { st.mode = "free"; st.flash = 0; }
            }

            // posisi target: bebas ↔ menempel
            const pf = freePos(seed, t, _v1);
            const pe = st.mode === "engage" || (st.mode === "release" && st.t < 0.5)
                ? engagePos(seed, t, _v2)
                : null;

            let cx, cy, cz, scale;

            if (st.mode === "free") {
                cx = pf.x; cy = pf.y; cz = pf.z;
                scale = 1 + Math.sin(t * 1.7 + seed.phase) * 0.1 + ex * 0.12;
            }
            else if (st.mode === "engage") {
                const k = ease(st.t);
                cx = pf.x + (pe.x - pf.x) * k;
                cy = pf.y + (pe.y - pf.y) * k;
                cz = pf.z + (pe.z - pf.z) * k;
                scale = 1 + k * 0.55 + Math.sin(t * 9 + seed.phase) * 0.08 * st.glow;
            }
            else { // release
                const k = ease(st.t);
                const back = st.t < 0.5
                    ? pe.clone().lerp(pf, k * 2)
                    : pf;
                cx = back.x; cy = back.y; cz = back.z;
                scale = 1.55 - k * 0.55;
            }

            st.pos.set(cx, cy, cz);

            // --- isi orb: bola kecil bergerigi lembut ---
            const spin = t * (0.5 + seed.spd * 3) + seed.phase;
            const flick = st.flash > 0
                ? tmpC.setHex(st.flashOK ? OK_HEX : FAIL_HEX)
                : null;

            for (let i = 0; i < count; i++) {
                const th = _ths[i % _ths.length] + spin;
                const ph = _phs[i % _phs.length];
                const rr = 0.2 * scale * (1 + Math.sin(t * 3 + i) * 0.14);
                pos[i * 3] = cx + rr * Math.sin(ph) * Math.cos(th);
                pos[i * 3 + 1] = cy + rr * Math.cos(ph);
                pos[i * 3 + 2] = cz + rr * Math.sin(ph) * Math.sin(th);

                // Warna: dasar agent, terang saat menyalurkan, ledakan
                // warna hasil saat release.
                tmpC.setHex(def.hex);
                if (st.glow > 0) tmpC.lerp(whiteC, st.glow * 0.4);
                if (flick) tmpC.lerp(flick, st.flash * 0.85);
                const br = 0.6 + st.glow * 0.5 + st.flash * 0.5 + Math.sin(t * 2.4 + i) * 0.08;
                col[i * 3] = tmpC.r * br;
                col[i * 3 + 1] = tmpC.g * br;
                col[i * 3 + 2] = tmpC.b * br;
            }
            mesh.geometry.attributes.position.needsUpdate = true;
            mesh.geometry.attributes.color.needsUpdate = true;

            st.flash = Math.max(0, st.flash - dt * 1.1);

            // --- lahirkan aliran energi saat menempel ---
            if (st.mode === "engage" && st.t > 0.55) {
                st.glowPulse = (st.glowPulse ?? 0) + dt;
                if (st.glowPulse > 0.045) {
                    st.glowPulse = 0;
                    spawnFlow(orbs.indexOf(orb), 2);
                }
            }
        }

        // --- aliran energi: agent → inti ---
        {
            const { pos, col } = flow.userData;
            let any = false;
            for (let i = 0; i < FLOW_N; i++) {
                if (flowAlive[i] <= 0) {
                    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
                    continue;
                }
                any = true;
                flowSeed[i * 2 + 1] += dt * 0.55;
                const life = flowSeed[i * 2 + 1];
                if (life >= 1) { flowAlive[i] = 0; continue; }

                const owner = orbs[flowSeed[i * 2]];
                if (!owner) { flowAlive[i] = 0; continue; }

                // kurva: dari orb agen melengkung masuk ke inti.
                const k = life * life * (3 - 2 * life);   // smoothstep
                _v1.copy(owner.st.pos);
                _v2.set(0, 0, 0);
                // titik kendali sedikit ke luar agar aliran melengkung.
                _v3.copy(_v1).lerp(_v2, 0.5).normalize().multiplyScalar(_v1.length() * 0.72);
                quadBezier(_v1, _v3, _v2, k, _v4);

                pos[i * 3] = _v4.x + Math.sin(i * 7.3 + life * 9) * 0.035;
                pos[i * 3 + 1] = _v4.y + Math.cos(i * 5.1 + life * 8) * 0.035;
                pos[i * 3 + 2] = _v4.z + Math.sin(i * 3.7 + life * 7) * 0.035;

                tmpC.setHex(owner.def.hex).lerp(whiteC, 0.35 + life * 0.4);
                const br = Math.sin(life * Math.PI);   // lahir & mati lembut
                col[i * 3] = tmpC.r * br;
                col[i * 3 + 1] = tmpC.g * br;
                col[i * 3 + 2] = tmpC.b * br;
            }
            if (any || flowWasAlive) {
                flow.geometry.attributes.position.needsUpdate = true;
                flow.geometry.attributes.color.needsUpdate = true;
            }
            flowWasAlive = any;
        }

    }

    let flowWasAlive = false;

    function destroy() {
        group.removeFromParent();
        for (const o of orbs) {
            o.mesh.geometry.dispose();
            o.mesh.material.dispose();
        }
        flow.geometry.dispose();
        flow.material.dispose();
        tex.dispose();
    }

    return { group, engage, release, update, destroy };

}

const ease = (x) => x * x * (3 - 2 * x);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

function quadBezier(p0, p1, p2, t, out) {
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    out.set(
        p0.x * a + p1.x * b + p2.x * c,
        p0.y * a + p1.y * b + p2.y * c,
        p0.z * a + p1.z * b + p2.z * c
    );
    return out;
}

// sudut tetap untuk isi orb (dibangun sekali)
const _ths = Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2);
const _phs = Array.from({ length: 24 }, (_, i) => Math.acos(2 * ((i * 0.618) % 1) - 1));
