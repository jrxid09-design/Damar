import * as THREE from "../../vendor/three.module.js";
import { aetherState } from "../aetherState.js";
import { agentBus } from "../agentBus.js";
import { createAgentSwarm } from "./swarmOrbs.js";

/**
 * AETHER SWARM ORB — entitas orb yang dibentuk oleh RIBUAN orb kecil.
 *
 * Desain (pivot dari orb padat):
 *   - TIDAK ADA lagi bola padat, kerangka, cincin data, atau arc —
 *     orb utama adalah KAWANAN PARTIKEL (±2.600 orb cahaya) yang
 *     berkumpul membentuk bola hidup: bernapas, berputar, bereaksi.
 *   - Lapis partikel:
 *       1. swarm inti (2.400 orb kecil — tubuh entitas)
 *       2. orb terang (220 orb besar — kilau spektrum)
 *       3. debu halo mengorbit (ambien sekitar entitas)
 *       4. bintang jauh (medan dalam, seisi layar)
 *       5. percikan audio (meledak mengikuti amplitudo suara)
 *   - INTERAKTIF:
 *       - KURSOR: orb miring & bergeser mengikuti pointer; gerakan
 *         cepat menaikkan "excite" (partikel bergetar antusias).
 *       - MIC: saat state masuk "listening", excite melonjak +
 *         ledakan percikan — Aether menyapa dengan antusias.
 *       - AUDIO: level mic/TTS menggembungkan swarm & memperterang.
 *
 * Palet per-state dari STATE_STYLE (amber identitas, cyan aktif,
 * violet kognisi, merah galat, hijau sukses).
 *
 * Kontrak interface TIDAK berubah:
 *   el, setState, setLevel, setMouth, pause, resume, destroy.
 */

// Palet spektrum amber×cyan.
const COL = {
    amber:  0xFFB84D,   // amber kekuningan — identitas
    amberD: 0xFF9A1F,
    gold:   0xFFD98A,
    cyan:   0x00DFFF,   // aktif
    cyanS:  0x73EDFF,
    violet: 0x7C5CFF,   // kognisi
    red:    0xFF3B3B,
    green:  0x21E6A4,
    white:  0xE8FCFF
};

// Warna & tempo per-state (bisa apa pun yang dikirim bus).
const STATE_STYLE = {
    idle:      { a: COL.amber,  b: COL.cyan,  tempo: 1.0, sparks: 0.10 },
    listening: { a: COL.cyan,   b: COL.amber, tempo: 1.6, sparks: 0.30 },
    focused:   { a: COL.amber,  b: COL.cyan,  tempo: 1.2, sparks: 0.15 },
    thinking:  { a: COL.violet, b: COL.cyan,  tempo: 2.2, sparks: 0.25 },
    analyzing: { a: COL.cyan,   b: COL.violet,tempo: 2.4, sparks: 0.30 },
    executing: { a: COL.cyan,   b: COL.amber, tempo: 2.0, sparks: 0.35 },
    speaking:  { a: COL.amber,  b: COL.gold,  tempo: 1.3, sparks: 0.50 },
    curious:   { a: COL.gold,   b: COL.cyan,  tempo: 1.1, sparks: 0.20 },
    happy:     { a: COL.green,  b: COL.gold,  tempo: 1.0, sparks: 0.40 },
    success:   { a: COL.green,  b: COL.cyan,  tempo: 0.9, sparks: 0.45 },
    alert:     { a: COL.white,  b: COL.amber, tempo: 2.0, sparks: 0.50 },
    error:     { a: COL.red,    b: COL.red,   tempo: 1.8, sparks: 0.30 },
    sleep:     { a: 0x39435E,   b: 0x2A3350,  tempo: 0.2, sparks: 0.0 },
    recovery:  { a: COL.green,  b: COL.amber, tempo: 0.8, sparks: 0.30 },
    offline:   { a: 0x39435E,   b: 0x2A3350,  tempo: 0.2, sparks: 0.0 }
};
const styleOf = (s) => STATE_STYLE[s] ?? STATE_STYLE.idle;

// Tekstur titik bulat lembut — agar tiap partikel benar-benar tampak
// sebagai "orb kecil" bercahaya, bukan kotak.
function makeDotTexture() {
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

export function createEntity({ maxFps = 60, particles = true } = {}) {

    const wrap = document.createElement("div");
    wrap.style.width = "100%";
    wrap.style.height = "100%";
    wrap.style.position = "relative";

    const renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: true, powerPreference: "low-power"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(320, 320);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    wrap.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();

    // Kamera lebih lebar + agak menjauh: orb AGENT yang terbang ke
    // tepi tidak lagi terpotong canvas (orbit agen ±4.8 vs halfH 5.3).
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 140);
    camera.position.set(0, 0, 14.5);
    camera.lookAt(0, 0, 0);

    // Gimbal membungkus root: kursor menggerakkan root, GESTUR TANGAN
    // menggerakkan gimbal — dua sumber putaran tak saling menimpa.
    const gimbal = new THREE.Group();
    scene.add(gimbal);
    const root = new THREE.Group();
    gimbal.add(root);

    const dotTex = makeDotTexture();

    const mkPoints = (count, size, opacity) => {
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const col = new Float32Array(count * 3);
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({
            size, map: dotTex, vertexColors: true, transparent: true, opacity,
            sizeAttenuation: true, depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const pts = new THREE.Points(geo, mat);
        pts.userData = { pos, col, count };
        return pts;
    };

    // ============================================================
    // BINTANG AMBIEN JAUH (medan dalam, seisi layar)
    // ============================================================
    let stars = null;
    if (particles) {
        stars = mkPoints(850, 0.055, 0.75);
        const { pos, col } = stars.userData;
        const cA = new THREE.Color(COL.amber), cB = new THREE.Color(COL.cyan), cW = new THREE.Color(COL.white);
        for (let i = 0; i < 850; i++) {
            const r = 6.5 + Math.random() * 16;
            const th = Math.random() * Math.PI * 2;
            const ph = Math.acos(2 * Math.random() - 1);
            pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
            pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.62;
            pos[i * 3 + 2] = r * Math.cos(ph);
            const roll = Math.random();
            const c = roll < 0.45 ? cA : roll < 0.85 ? cB : cW;
            col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        }
        stars.geometry.attributes.position.needsUpdate = true;
        stars.geometry.attributes.color.needsUpdate = true;
        root.add(stars);
    }

    // ============================================================
    // DEBU HALO — ambien mengorbit di sekitar entitas
    // ============================================================
    const DUST_N = 620;
    const dust = mkPoints(DUST_N, 0.042, 0.7);
    const dustSeeds = new Float32Array(DUST_N * 4); // r, th, ph, spd
    {
        const { col } = dust.userData;
        const cA = new THREE.Color(COL.amber), cB = new THREE.Color(COL.cyan);
        for (let i = 0; i < DUST_N; i++) {
            dustSeeds[i * 4] = 2.1 + Math.pow(Math.random(), 0.6) * 3.6;
            dustSeeds[i * 4 + 1] = Math.random() * Math.PI * 2;
            dustSeeds[i * 4 + 2] = Math.random() * Math.PI * 2;
            dustSeeds[i * 4 + 3] = 0.12 + Math.random() * 0.4;
            const c = Math.random() < 0.5 ? cA : cB;
            col[i * 3] = c.r * 0.7; col[i * 3 + 1] = c.g * 0.7; col[i * 3 + 2] = c.b * 0.7;
        }
        dust.geometry.attributes.color.needsUpdate = true;
    }
    root.add(dust);

    // ============================================================
    // SWARM — TUBUH ENTITAS gaya Siri: inti padat + DUA LAPIS
    // swirl yang berlawanan arah + kilau besar. Orb utama lebih
    // besar (R utama 2.1) dengan lapisan mengalir organik.
    // ============================================================

    // --- Inti padat: bola cahaya putih terang (jantung Siri).
    const CORE_N = 900;
    const core = mkPoints(CORE_N, 0.075, 0.95);
    const coreSeeds = new Float32Array(CORE_N * 5);
    for (let i = 0; i < CORE_N; i++) {
        const rr = 0.05 + 0.95 * Math.pow(Math.random(), 0.4);   // padat ke pusat
        coreSeeds[i * 5] = rr * 0.95;
        coreSeeds[i * 5 + 1] = Math.random() * Math.PI * 2;
        coreSeeds[i * 5 + 2] = Math.acos(2 * Math.random() - 1);
        coreSeeds[i * 5 + 3] = 0.15 + Math.random() * 0.5;
        coreSeeds[i * 5 + 4] = 1;                                // selalu putih terang
    }
    root.add(core);

    // --- Swirl luar: pita yang MENGALIR melengkung (bukan bola statis).
    //     Tiap partikel menempel pada "pita" sinus yang berputar.
    const SWARM_N = 2600;
    const swarm = mkPoints(SWARM_N, 0.06, 0.85);
    const swarmSeeds = new Float32Array(SWARM_N * 6);   // r0, th0, ph, spd, whiteMix, ribbon
    for (let i = 0; i < SWARM_N; i++) {
        const rr = 0.55 + 0.45 * Math.pow(Math.random(), 0.55);
        swarmSeeds[i * 6] = rr * 2.1;
        swarmSeeds[i * 6 + 1] = Math.random() * Math.PI * 2;
        swarmSeeds[i * 6 + 2] = Math.acos(2 * Math.random() - 1);
        swarmSeeds[i * 6 + 3] = 0.1 + Math.random() * 0.45;
        swarmSeeds[i * 6 + 4] = Math.max(0, 0.55 - rr / 2.1) * 0.9;
        swarmSeeds[i * 6 + 5] = (i % 2) * Math.PI;              // 2 pita berlawanan
    }
    root.add(swarm);

    // --- Kilau besar: bintang spektrum di kulit swirl.
    const BRIGHT_N = 260;
    const brights = mkPoints(BRIGHT_N, 0.13, 0.9);
    const brightSeeds = new Float32Array(BRIGHT_N * 6);
    for (let i = 0; i < BRIGHT_N; i++) {
        const rr = 0.6 + 0.4 * Math.cbrt(Math.random());
        brightSeeds[i * 6] = rr * 2.05;
        brightSeeds[i * 6 + 1] = Math.random() * Math.PI * 2;
        brightSeeds[i * 6 + 2] = Math.acos(2 * Math.random() - 1);
        brightSeeds[i * 6 + 3] = 0.06 + Math.random() * 0.3;
        brightSeeds[i * 6 + 4] = Math.max(0, 1 - rr / 1.6);
        brightSeeds[i * 6 + 5] = (i % 2) * Math.PI;
    }
    root.add(brights);

    // ============================================================
    // PERCIKAN AUDIO — meledak keluar mengikuti suara & antusiasme
    // ============================================================
    const SPARK_N = 420;
    const sparks = mkPoints(SPARK_N, 0.08, 0.95);
    const sparkSeeds = new Float32Array(SPARK_N * 3);   // th, ph, life
    const sparkLife = new Float32Array(SPARK_N);
    {
        const { pos } = sparks.userData;
        for (let i = 0; i < SPARK_N; i++) {
            sparkSeeds[i * 3] = Math.random() * Math.PI * 2;
            sparkSeeds[i * 3 + 1] = Math.acos(2 * Math.random() - 1);
            sparkLife[i] = Math.random();
            pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0;
        }
    }
    root.add(sparks);

    // Pembersihan tambahan (dipakai agentSwarm dsb.) — dideklarasikan
    // sebelum lapisan yang memakainya.
    const destroyHooks = [];

    // ============================================================
    // SWARM ORB AGEN — 12 orb kecil bersemanyam di sekitar inti.
    // Terhubung agentBus: agent dipakai → orb mendekat & menyalurkan
    // energi; selesai → pulang + flash hijau/merah hasil.
    // ============================================================
    let agentSwarm = null;
    try {
        agentSwarm = createAgentSwarm({ root, excite: () => excite });
        const unsubAgents = agentBus.subscribe(evt => {
            if (!agentSwarm) return;
            if (evt.t === "engage") agentSwarm.engage(evt.id);
            else if (evt.t === "release") agentSwarm.release(evt.id, evt.ok);
        });
        destroyHooks.push(unsubAgents);
    }
    catch { /* WebGL/scene gagal → orb utama tetap hidup */ }

    // ============================================================
    // STATE, KURSOR & ANTUSIASME
    // ============================================================
    let current = "idle";
    let running = true, raf = 0, last = 0;
    const frameInterval = 1000 / maxFps;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const colA = new THREE.Color(COL.amber);
    const colB = new THREE.Color(COL.cyan);
    const tmpC = new THREE.Color();
    const whiteC = new THREE.Color(COL.white);

    let sparkBudget = 0;
    let excite = 0;          // antusiasme 0..~1.8 (kursor, mic, suara)

    // Kursor: orb condong & mengikuti pointer; gerak cepat = excite.
    let px = 0, py = 0;
    const onPointer = (e) => {
        const nx = (e.clientX / window.innerWidth) * 2 - 1;
        const ny = (e.clientY / window.innerHeight) * 2 - 1;
        const speed = Math.min(0.35, Math.hypot(nx - px, ny - py));
        excite = Math.min(1.8, excite + speed * 3.0);
        px = nx; py = ny;
    };
    if (!reduced) window.addEventListener("pointermove", onPointer, { passive: true });

    function setState(next) { current = next; }

    const setLevel = () => { /* via bus */ };
    const setMouth = () => { };

    // Masuk mode dengar → AETHER ANTUSIAS: lonjakan excite + ledakan
    // percikan sapaan (bukan sekadar ganti warna).
    const unsub = aetherState.subscribe((s) => {
        if (s === "listening" && current !== "listening") {
            excite = Math.min(1.9, excite + 1.5);
            sparkBudget += 130;
        }
        current = s;
    });

    function tick(now) {
        raf = requestAnimationFrame(tick);
        if (!running) return;
        if (now - last < frameInterval) return;
        const dt = Math.min(0.05, (now - last) / 1000) || 0.016;
        last = now;

        const t = now * 0.001;
        const st = styleOf(current);
        const tempo = st.tempo;
        const lv = aetherState.level;    // suara user
        const mo = aetherState.mouth;    // suara Aether
        const amp = Math.max(lv, mo);    // amplitudo gabungan

        // Excite meluruh; saat mendengar ada lantai tinggi (tetap semangat).
        const floor = current === "listening" ? 0.9 : 0.04;
        excite = Math.max(floor, excite * Math.exp(-dt * 1.35));

        // Warna bertransisi halus.
        colA.lerp(tmpC.setHex(st.a), 0.06);
        colB.lerp(tmpC.setHex(st.b), 0.06);

        // --- INTI PADAT: jantung terang gaya Siri (bernapas cepat) ---
        {
            const { pos, col, count } = core.userData;
            const pulse = 1 + Math.sin(t * 2.2) * 0.05 + amp * 0.3 + excite * 0.12;
            for (let i = 0; i < count; i++) {
                const r0 = coreSeeds[i * 5], th0 = coreSeeds[i * 5 + 1],
                    ph0 = coreSeeds[i * 5 + 2], sp = coreSeeds[i * 5 + 3];
                const th = th0 + t * sp * 0.6 * tempo;
                const rr = r0 * pulse + Math.sin(t * 6 + i) * 0.012;
                pos[i * 3] = rr * Math.sin(ph0) * Math.cos(th);
                pos[i * 3 + 1] = rr * Math.cos(ph0);
                pos[i * 3 + 2] = rr * Math.sin(ph0) * Math.sin(th);
                const br = 0.9 + Math.sin(t * 3 + i * 0.37) * 0.1;
                col[i * 3] = tmpC.copy(whiteC).lerp(colA, 0.12).r * br;
                col[i * 3 + 1] = tmpC.g * br;
                col[i * 3 + 2] = tmpC.b * br;
            }
            core.geometry.attributes.position.needsUpdate = true;
            core.geometry.attributes.color.needsUpdate = true;
            core.material.opacity = 0.85 + amp * 0.15;
        }

        // --- SWIRL: pita mengalir berlawanan arah (tubuh Siri) ---
        {
            const { pos, col, count } = swarm.userData;
            const swell = 1 + amp * 0.1 + excite * 0.07;
            const jit = 0.01 + excite * 0.03;
            for (let i = 0; i < count; i++) {
                const r0 = swarmSeeds[i * 6], th0 = swarmSeeds[i * 6 + 1],
                    ph0 = swarmSeeds[i * 6 + 2], sp = swarmSeeds[i * 6 + 3],
                    wm = swarmSeeds[i * 6 + 4], ribbon = swarmSeeds[i * 6 + 5];
                // Tiap pita berputar berlawanan; partikel meluncur di pita.
                const dir = ribbon > 0 ? 1 : -1;
                const th = th0 + dir * t * (0.14 + sp * 0.5) * tempo;
                // Gelombang pita: radius berosilasi mengikuti sudut — anyaman organik.
                const wave = Math.sin(th * 2 + t * 0.8 + ribbon) * 0.24
                    + Math.cos(ph0 * 3 + t * 0.5) * 0.1;
                const rr = (r0 + wave) * swell
                    + Math.sin(t * (5 + sp * 5) + i) * jit;
                pos[i * 3] = rr * Math.sin(ph0) * Math.cos(th);
                pos[i * 3 + 1] = rr * Math.cos(ph0) * 0.96;
                pos[i * 3 + 2] = rr * Math.sin(ph0) * Math.sin(th);
                tmpC.copy(i % 2 ? colA : colB).lerp(whiteC, wm * 0.5);
                const br = 0.5 + amp * 0.4 + excite * 0.16;
                col[i * 3] = tmpC.r * br; col[i * 3 + 1] = tmpC.g * br; col[i * 3 + 2] = tmpC.b * br;
            }
            swarm.geometry.attributes.position.needsUpdate = true;
            swarm.geometry.attributes.color.needsUpdate = true;
            swarm.material.opacity = 0.7 + amp * 0.18 + excite * 0.08;
        }

        // --- KILAU BESAR: bintang spektrum di kulit swirl ---
        {
            const { pos, col, count } = brights.userData;
            const swell = 1 + amp * 0.14 + excite * 0.1;
            for (let i = 0; i < count; i++) {
                const r0 = brightSeeds[i * 6], th0 = brightSeeds[i * 6 + 1],
                    ph0 = brightSeeds[i * 6 + 2], sp = brightSeeds[i * 6 + 3],
                    wm = brightSeeds[i * 6 + 4], ribbon = brightSeeds[i * 6 + 5];
                const dir = ribbon > 0 ? 1 : -1;
                const th = th0 + dir * t * (0.1 + sp * 0.4) * tempo;
                const wave = Math.sin(th * 2 + t * 0.7 + ribbon) * 0.2;
                const rr = (r0 + wave) * swell * (1 + Math.sin(t * 1.1 + ph0 * 2) * 0.04);
                pos[i * 3] = rr * Math.sin(ph0) * Math.cos(th);
                pos[i * 3 + 1] = rr * Math.cos(ph0) * 0.96;
                pos[i * 3 + 2] = rr * Math.sin(ph0) * Math.sin(th);
                tmpC.copy(i % 3 === 0 ? colB : colA).lerp(whiteC, wm * 0.5 + 0.15);
                const br = 0.75 + amp * 0.4 + excite * 0.2 + Math.sin(t * 2.2 + i) * 0.1;
                col[i * 3] = tmpC.r * br; col[i * 3 + 1] = tmpC.g * br; col[i * 3 + 2] = tmpC.b * br;
            }
            brights.geometry.attributes.position.needsUpdate = true;
            brights.geometry.attributes.color.needsUpdate = true;
        }

        // --- DEBU HALO: orbit ambien + dispersi audio ---
        if (!reduced) {
            const { pos, count } = dust.userData;
            const disp = 1 + amp * 0.5 + excite * 0.25;
            for (let i = 0; i < count; i++) {
                const r0 = dustSeeds[i * 4], th0 = dustSeeds[i * 4 + 1],
                    ph = dustSeeds[i * 4 + 2], sp = dustSeeds[i * 4 + 3];
                const th = th0 + t * sp * 0.3 * tempo;
                const rr = r0 * disp * (1 + Math.sin(t * 0.7 + ph) * 0.05);
                pos[i * 3] = Math.cos(th) * rr;
                pos[i * 3 + 1] = Math.sin(t * (0.6 + sp) + ph * 2) * 0.3 + Math.sin(ph) * rr * 0.16;
                pos[i * 3 + 2] = Math.sin(th) * rr;
            }
            dust.geometry.attributes.position.needsUpdate = true;
        }

        // --- BINTANG: rotasi sangat pelan + twinkle ---
        if (stars && !reduced) {
            stars.rotation.y += dt * 0.012 * tempo;
            stars.material.opacity = 0.55 + Math.sin(t * 0.8) * 0.12 + amp * 0.15;
        }

        // --- PERCIKAN: lahir dari suara & excite ---
        {

            const { pos, col, count } = sparks.userData;
            sparkBudget += dt * (st.sparks + amp * 3.2 + excite * 1.1) * 26;
            let born = Math.floor(sparkBudget);
            sparkBudget -= born;            for (let i = 0; i < count; i++) {
                if (sparkLife[i] > 0) {
                    sparkLife[i] -= dt * 1.35;
                    const life = 1 - sparkLife[i];
                    const dist = 1.15 + life * (3.2 + amp * 3.0 + excite * 1.4);
                    const th = sparkSeeds[i * 3], ph = sparkSeeds[i * 3 + 1];
                    pos[i * 3] = Math.sin(ph) * Math.cos(th) * dist;
                    pos[i * 3 + 1] = Math.cos(ph) * dist * 0.8;
                    pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * dist;
                    const fade = Math.max(0, sparkLife[i]);
                    tmpC.copy(life < 0.25 ? whiteC : (i % 2 ? colA : colB));
                    col[i * 3] = tmpC.r * fade; col[i * 3 + 1] = tmpC.g * fade; col[i * 3 + 2] = tmpC.b * fade;
                } else if (born > 0) {
                    born--;
                    sparkLife[i] = 1;
                    sparkSeeds[i * 3] = Math.random() * Math.PI * 2;
                    sparkSeeds[i * 3 + 1] = Math.acos(2 * Math.random() - 1);
                } else {
                    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
                }
            }
            sparks.geometry.attributes.position.needsUpdate = true;
            sparks.geometry.attributes.color.needsUpdate = true;
        }

        // --- SWARM ORB AGEN: update tiap frame ---
        agentSwarm?.update(dt, t);

        // --- CONDONG KE KURSOR: orb "menoleh" ke pengguna ---
        root.rotation.x += ((-py * 0.3 + Math.sin(t * 0.13) * 0.03) - root.rotation.x) * 0.06;
        root.rotation.y += ((px * 0.45 + Math.sin(t * 0.16) * 0.07) - root.rotation.y) * 0.06;
        root.position.x += (px * 0.36 - root.position.x) * 0.05;
        root.position.y += (-py * 0.22 - root.position.y) * 0.05;

        renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);

    function resize() {
        const w = wrap.clientWidth || 320, h = wrap.clientHeight || 320;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    setTimeout(resize, 0);

    setState("idle");

    function pause() { running = false; }
    function resume() { running = true; }

    // --- Kontrol gestur (dipakai HandTracker): putar gimbal, geser kamera.
    const ZCAM_MIN = 8, ZCAM_MAX = 22;
    function rotate(dTheta = 0, dPhi = 0) {
        gimbal.rotation.y += dTheta;
        gimbal.rotation.x = Math.max(-1.2, Math.min(1.2, gimbal.rotation.x + dPhi));
    }
    function zoom(factor = 1) {
        camera.position.z = Math.max(ZCAM_MIN, Math.min(ZCAM_MAX, camera.position.z * factor));
    }
    function resetView() {
        gimbal.rotation.set(0, 0, 0);
        camera.position.z = 14.5;
    }

    function destroy() {
        running = false;
        cancelAnimationFrame(raf);
        unsub();
        observer.disconnect();
        window.removeEventListener("pointermove", onPointer);
        for (const fn of destroyHooks) { try { fn(); } catch { /* abaikan */ } }
        agentSwarm?.destroy();
        renderer.dispose();
        renderer.forceContextLoss?.();
        root.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        dotTex.dispose();
        wrap.remove();
    }

    return {
        el: wrap,
        get state() { return current; },
        setState, setLevel, setMouth,
        pause, resume, destroy,
        rotate, zoom, resetView,
        walkTo() {}, setMood() {}
    };
}
