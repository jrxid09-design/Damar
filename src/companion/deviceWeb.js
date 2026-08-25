/**
 * deviceWeb v3 — halaman DEVICE TERTAUT, desain final "orb-only".
 *
 *   • Satu-satunya panggung: ORB canvas — blob berlapis ala Siri/LiveKit
 *     yang bergerak ORGANIK (noise multi-sinus acak) dan mengikuti SUARA:
 *     band bass/mid/treble dari frekuensi mic saat listening, dari audio
 *     TTS server saat speaking, denyut sintetis saat thinking.
 *   • TAHAN orb = push-to-talk; lepas = kirim. Barge-in: tahan saat Aether
 *     bicara akan memotong TTS.
 *   • Kotak ketik tidak melayang lagi — ia bagian dari PANEL CHAT opsional
 *     (tombol ☰). Quick chips dihapus.
 *   • Setelan ⚙: ganti PROVIDER & MODEL AI (ala Console), mode suara,
 *     kecepatan, nama device, keluar.
 *   • Media dirender; lampiran 📎 diunggah & diberitahukan ke Aether.
 *   • Mic butuh SECURE CONTEXT: bila dibuka via http://100.x… browser
 *     memblokirnya — halaman menuntun ke `tailscale serve`.
 *
 * Vanilla HTML/CSS/JS, tanpa build step.
 */
function html() {

return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>AETHER · Companion</title>
<style>
    :root { --bg:#04070c; --cyan:#35e0ff; --cyan-dim:rgba(53,224,255,.32);
        --cyan-faint:rgba(53,224,255,.07); --text:#d7f4fb; --muted:#5d8794;
        --danger:#ff5470; --mono:ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace; }
    * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    html,body { height:100%; }
    body { background:radial-gradient(ellipse at 50% 26%, rgba(53,224,255,.06), transparent 60%), var(--bg);
        color:var(--text); font-family:var(--mono); display:flex; flex-direction:column; align-items:center;
        padding:max(10px,env(safe-area-inset-top)) 14px max(12px,env(safe-area-inset-bottom));
        overflow:hidden; position:fixed; inset:0; }

    .top { width:100%; max-width:460px; display:flex; align-items:center; gap:8px; z-index:5; }
    .brand { font-size:11px; letter-spacing:7px; color:var(--cyan); flex:1; text-transform:uppercase; }
    .status { font-size:9px; letter-spacing:2px; color:var(--muted); text-transform:uppercase;
              border:1px solid var(--cyan-dim); padding:4px 9px; border-radius:2px;
              white-space:nowrap; max-width:52%; overflow:hidden; text-overflow:ellipsis; }
    .icobtn { background:none; border:1px solid var(--cyan-dim); color:var(--muted); width:30px; height:30px;
              border-radius:3px; margin:0; padding:0; display:flex; align-items:center;
              justify-content:center; font-size:13px; }
    .icobtn:hover { color:var(--cyan); border-color:var(--cyan); box-shadow:none; }

    .orb-zone { flex:1; width:100%; max-width:460px; display:flex; flex-direction:column;
                align-items:center; justify-content:center; gap:14px; min-height:110px; }
    #orb { width:min(78vw,320px); height:min(78vw,320px);
           filter:drop-shadow(0 0 30px var(--cyan-dim)); touch-action:none;
           cursor:pointer; user-select:none; -webkit-user-select:none; }
    body.holding #orb { filter:drop-shadow(0 0 46px rgba(53,224,255,.55)); }
    .hint { font-size:9px; letter-spacing:2.5px; color:var(--muted); text-transform:uppercase;
            text-align:center; min-height:12px; }

    /* ---- panel chat opsional ---- */
    #chatwrap { width:100%; max-width:460px; display:none; flex-direction:column; z-index:6; }
    #chatwrap.open { display:flex; }
    .drawer { max-height:34vh; overflow-y:auto; border:1px solid var(--cyan-dim); border-radius:4px 4px 0 0;
        border-bottom:none; background:linear-gradient(180deg, rgba(53,224,255,.05), transparent 65%);
        padding:12px; display:flex; flex-direction:column; gap:9px;
        scrollbar-width:thin; scrollbar-color:var(--cyan-dim) transparent; }
    .msg { max-width:88%; font-size:12.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
    .msg.user { align-self:flex-end; color:#fff; border-right:2px solid var(--cyan); padding-right:9px; }
    .msg.aether { align-self:flex-start; border-left:2px solid var(--cyan-dim); padding-left:9px; }
    .msg.aether::before { content:"AETHER"; display:block; font-size:8px; letter-spacing:3px;
                          color:var(--muted); margin-bottom:3px; }
    .msg img { max-width:100%; max-height:210px; margin-top:8px; border:1px solid var(--cyan-dim);
               border-radius:3px; cursor:pointer; display:block; }
    .caret { display:inline-block; width:7px; height:13px; background:var(--cyan);
             vertical-align:text-bottom; animation:blink .9s steps(1) infinite; }
    @keyframes blink { 50% { opacity:0; } }
    a.chipfile { display:inline-block; font-size:10px; border:1px solid var(--cyan-dim); padding:4px 9px;
                 margin-top:6px; border-radius:2px; color:var(--cyan); text-decoration:none; letter-spacing:1px; }

    .inrow { display:flex; gap:7px; border:1px solid var(--cyan-dim); border-top:none;
             border-radius:0 0 4px 4px; padding:8px; background:rgba(53,224,255,.03); }
    .inrow input { flex:1; background:transparent; border:none; outline:none; color:var(--text);
                   font-family:var(--mono); font-size:13px; min-width:0; }
    .inrow button { width:auto; margin:0; padding:6px 11px; font-size:14px; line-height:1;
                    background:none; border:none; color:var(--cyan); border-radius:3px; }
    .inrow button:hover { box-shadow:none; background:rgba(53,224,255,.08); }

    /* ---- pairing & sheet ---- */
    .panel { border:1px solid var(--cyan-dim); background:linear-gradient(180deg, rgba(53,224,255,.05), transparent 55%);
             border-radius:4px; padding:18px; position:relative; width:100%; max-width:420px; }
    .panel::before,.panel::after,.panel .corner::before,.panel .corner::after
      { content:""; position:absolute; width:14px; height:14px; border-color:var(--cyan); border-style:solid; }
    .panel::before{top:-1px;left:-1px;border-width:2px 0 0 2px}
    .panel::after{top:-1px;right:-1px;border-width:2px 2px 0 0}
    .panel .corner::before{bottom:-1px;left:-1px;border-width:0 0 2px 2px}
    .panel .corner::after{bottom:-1px;right:-1px;border-width:0 2px 2px 0}
    .label { font-size:10px; letter-spacing:3px; color:var(--muted); text-transform:uppercase; margin-bottom:8px; }
    #pair-view { width:100%; display:flex; justify-content:center; }
    input[type=text], select { width:100%; background:rgba(53,224,255,.04); border:1px solid var(--cyan-dim);
        border-radius:3px; color:var(--text); font-family:var(--mono); font-size:14px; padding:10px 11px; outline:none; }
    select option { background:#071019; }
    input.code { letter-spacing:10px; font-size:22px; text-align:center; text-transform:uppercase; }
    .bigbtn { width:100%; margin-top:12px; cursor:pointer; background:rgba(53,224,255,.1); color:var(--cyan);
              border:1px solid var(--cyan); border-radius:3px; font-family:var(--mono); font-size:12px;
              letter-spacing:3px; text-transform:uppercase; padding:12px; }
    .bigbtn:hover { background:rgba(53,224,255,.22); }
    .error { color:var(--danger); font-size:11px; margin-top:9px; min-height:14px; }

    .sheet-bg { position:fixed; inset:0; background:rgba(2,5,9,.74); backdrop-filter:blur(3px);
                display:none; z-index:40; align-items:flex-end; justify-content:center; overflow-y:auto; }
    .sheet-bg.open { display:flex; }
    .sheet { width:100%; max-width:460px; background:#071019; border:1px solid var(--cyan-dim); border-bottom:none;
             border-radius:10px 10px 0 0; padding:18px 18px calc(18px + env(safe-area-inset-bottom)); }
    .sheet h3 { font-size:11px; letter-spacing:4px; color:var(--cyan); text-transform:uppercase; margin-bottom:14px; }
    .field { margin-bottom:13px; }
    .field label { display:block; font-size:9px; letter-spacing:2px; color:var(--muted);
                   text-transform:uppercase; margin-bottom:6px; }
    .seg { display:flex; gap:6px; }
    .seg button { width:auto; flex:1; margin:0; padding:9px 4px; font-size:9px; letter-spacing:1px;
                  background:none; border:1px solid var(--cyan-dim); color:var(--muted); border-radius:3px; }
    .seg button.on { color:var(--cyan); border-color:var(--cyan); background:rgba(53,224,255,.09); }
    input[type=range] { width:100%; accent-color:var(--cyan); }
    .row2 { display:flex; gap:8px; margin-top:4px; }
    .row2 .bigbtn { margin-top:0; }
    .btn-danger { border-color:var(--danger)!important; color:var(--danger)!important; background:none!important; }
    #orbFallback { display:none; width:min(72vw,300px); height:min(72vw,300px); border-radius:50%;
        background: radial-gradient(circle at 42% 36%, rgba(120,235,255,.55), rgba(53,224,255,.16) 46%, rgba(53,224,255,.03) 72%);
        filter: drop-shadow(0 0 34px var(--cyan-dim)); animation: fbPulse 3.2s ease-in-out infinite; }
    @keyframes fbPulse { 50% { transform: scale(1.06); } }

    .cur { font-size:10px; color:var(--muted); letter-spacing:1px; margin-top:5px; word-break:break-all; }
</style>
</head>
<body>

<div class="top">
    <div class="brand">Aether</div>
    <span class="status" id="status">LINK…</span>
    <button class="icobtn" id="btn-log" title="Chat">&#9776;</button>
    <button class="icobtn" id="btn-set" title="Setelan">&#9881;</button>
</div>

<div class="orb-zone">
    <canvas id="orb" width="720" height="720"></canvas>
    <div id="orbFallback"></div>
    <div class="hint" id="hint">tahan orb untuk bicara</div>
</div>

<!-- PANEL CHAT OPSIONAL (input menempel di sini) -->
<div id="chatwrap">
    <div class="drawer" id="log"></div>
    <div class="inrow">
        <button id="btn-att" title="Lampiran">&#128206;</button>
        <input type="text" id="say" placeholder="Ketik perintah…" autocomplete="off">
        <button id="btn-send" title="Kirim">&#10148;</button>
    </div>
</div>

<input type="file" id="file" accept="image/*,application/pdf,audio/*,.txt,.md" style="display:none">

<div id="pair-view" style="display:none; margin-top:22vh;">
    <div class="panel"><span class="corner"></span>
        <div class="label">Device pairing</div>
        <input type="text" id="code" class="code" maxlength="6" placeholder="- - - - - -"
               inputmode="numeric" autocomplete="one-time-code">
        <input type="text" id="dev-name" placeholder="Nama device" style="margin-top:10px">
        <button class="bigbtn" id="btn-join">Hubungkan</button>
        <div class="error" id="err"></div>
    </div>
    <p style="font-size:10px;color:var(--muted);margin-top:12px;text-align:center;letter-spacing:1px;line-height:1.7">
        Kode 6 digit: Console PC &rarr; Devices &rarr; Mulai pairing<br>
        Mic butuh HTTPS — di PC jalankan: <b>tailscale serve 3000</b>
    </p>
</div>

<div class="sheet-bg" id="setbg">
    <div class="sheet">
        <h3>&#9881; Setelan</h3>

        <div class="field">
            <label>Otak AI — provider</label>
            <select id="set-provider"><option value="">memuat…</option></select>
            <div class="cur" id="cur-ai"></div>
        </div>
        <div class="field">
            <label>API base URL</label>
            <input type="text" id="set-url" placeholder="https://openrouter.ai/api/v1">
        </div>
        <div class="field">
            <label>API key (kosong = tidak diubah)</label>
            <input type="password" id="set-key" placeholder="" autocomplete="off">
        </div>
        <div class="field">
            <label>Model</label>
            <input type="text" id="set-model-text" list="model-list" placeholder="">
            <datalist id="model-list"></datalist>
            <button class="bigbtn" id="btn-models" style="margin-top:8px;padding:9px">Muat daftar model</button>
            <div class="cur" id="model-hint"></div>
        </div>

        <div class="field">
            <label>Suara balasan Aether</label>
            <div class="seg" id="tts-seg">
                <button data-v="browser">Browser</button>
                <button data-v="server">Server (Ardi)</button>
                <button data-v="off">Mati</button>
            </div>
        </div>
        <div class="field">
            <label>Kecepatan suara browser (<span id="rate-val">1</span>&times;)</label>
            <input type="range" id="rate" min="0.6" max="1.6" step="0.05" value="1">
        </div>
        <div class="field">
            <label>Nama device</label>
            <input type="text" id="set-name">
        </div>
        <div class="field" style="margin-top:16px">
            <label style="color:var(--danger)">Panic — hentikan semua tool Aether</label>
            <input type="text" id="panic-confirm" placeholder="ketik STOP untuk konfirmasi"
                   style="border-color:rgba(255,84,112,.5)">
            <button class="bigbtn btn-danger" id="btn-panic">Tarik kill switch</button>
        </div>
        <div class="row2">
            <button class="bigbtn" id="btn-saveset">Simpan</button>
            <button class="bigbtn btn-danger" id="btn-logout">Keluar</button>
        </div>
    </div>
</div>

<script type="x-shader/x-fragment" id="frag">
// Orb JARVIS — fbm + domain warping, reaktif suara (ala LiveKit).
precision highp float;
uniform vec2  u_res;
uniform float u_time;
uniform float u_amp;    // amplitudo keseluruhan 0..1
uniform float u_bass;
uniform float u_mid;
uniform float u_treb;
uniform float u_val;   // valensi -1..1
uniform float u_aro;   // arousal 0..1
uniform float u_mode;   // 0 idle · 1 listening · 2 thinking · 3 speaking

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i),               hash(i+vec2(1.,0.)), u.x),
               mix(hash(i+vec2(0.,1.)),   hash(i+vec2(1.,1.)), u.x), u.y);
}
float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    mat2 r = mat2(0.80, 0.60, -0.60, 0.80);
    for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
    return v;
}

void main(){
    vec2 uv  = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
    float t  = u_time;

    // dinamika per mode: listening/speaking lebih hidup; thinking berputar cepat.
    float speed = 0.20 + u_amp * 1.05 + (u_mode == 2.0 ? 0.40 : 0.0)
                            + (u_mode == 1.0 ? 0.15 : 0.0);
    float warp  = 0.62 + u_amp * 1.75 + u_bass * 1.10;

    vec2 p = uv * 1.85;
    float ca = cos(t*0.13), sa = sin(t*0.13);
    p = mat2(ca, -sa, sa, ca) * p;

    // domain warping 2-tahap (kunci rasa "cair" ala LiveKit).
    vec2 q = vec2(fbm(p + t*0.30*speed),
                  fbm(p + vec2(4.7, 2.1) - t*0.24*speed));
    vec2 r = vec2(fbm(p + warp*q + vec2(1.7, 9.2) + t*0.16*speed),
                  fbm(p + warp*q + vec2(8.3, 2.8) - t*0.12*speed));
    float f = fbm(p + warp*r);

    // tepi blob bergelombang noise.
    float d    = length(uv);
    float edge = 0.60 + u_amp*0.11 + (f-0.5)*0.58*(0.38+u_amp);
    float body = smoothstep(edge, edge-0.30, d);

    // cincin detail — rasa ekualiser, dikuasai treble.
    float rings  = sin(d*24.0 - t*2.6 + f*7.4)*0.5 + 0.5;
    float detail = mix(1.0, rings, 0.20 + u_treb*0.55);

    // rim fresnel.
    float rim = smoothstep(edge-0.17, edge, d) * smoothstep(edge+0.11, edge, d);

    // Mood kesadaran: valensi negatif menggeser ke merah hangat,
    // positif ke hijau-teal menenangkan; arousal menaikkan intensitas.
    float neg = clamp(-u_val, 0.0, 1.0);
    float pos = clamp(u_val, 0.0, 1.0);
    vec3 deep = mix(vec3(0.05, 0.34, 0.42), vec3(0.45, 0.10, 0.10), neg * 0.9);
    deep      = mix(deep, vec3(0.06, 0.42, 0.30), pos * 0.6);
    vec3 hi   = mix(vec3(0.36, 0.96, 1.06), vec3(1.15, 0.45, 0.40), neg * 0.85);
    hi        = mix(hi, vec3(0.55, 1.20, 0.85), pos * 0.5);
    vec3 col  = mix(deep, hi, clamp(f*1.45-0.22, 0.0, 1.0)) * body;
    col *= detail * (0.72 + u_mid*0.95);
    col += hi * rim * (0.50 + u_amp*0.85);

    // denyut inti.
    col += hi * exp(-d*d*9.5) * (0.30 + u_amp*0.80);

    // alpha: hanya orb (canvas transparan di atas latar halaman).
    float a = clamp(body + rim*0.85, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
}
</script>

<script>
(function () {

    "use strict";

    // ================= STATE =================
    var $ = function (id) { return document.getElementById(id); };
    var TOKEN_KEY = "aether_companion_token";
    var NAME_KEY = "aether_companion_name";
    var SET_KEY = "aether_companion_settings";

    var token = localStorage.getItem(TOKEN_KEY);
    var devName = localStorage.getItem(NAME_KEY) || "device";
    var settings = { ttsMode: "browser", rate: 1 };
    try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || "{}")); } catch (e) {}

    var mode = "idle";      // idle | listening | thinking | speaking
    var busy = false;       // stream berjalan
    var holding = false;    // PTT ditahan

    var statusEl = $("status"), logEl = $("log"), hintEl = $("hint");

    function setStatus(t) { statusEl.textContent = t; }
    function setHint(t) { hintEl.textContent = t || ""; }
    function setMode(m) {
        mode = m;
        document.body.classList.toggle("holding", m === "listening");
        setStatus(
            m === "listening" ? "LISTENING…" :
            m === "thinking"  ? "THINKING…"  :
            m === "speaking"  ? "SPEAKING"   :
            (token ? ("LINKED · " + devName.toUpperCase()) : "LINK…")
        );
        if (m === "idle") setHint("tahan orb untuk bicara · ☰ chat");
    }

    function authHeaders(extra) {
        var h = extra || {};
        if (token) h["Authorization"] = "Bearer " + token;
        return h;
    }


    // ================= ORB v4 — WebGL shader (fbm warp, ala LiveKit) ====
    var canvas = $("orb");
    var gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: true });
    var glProg = null, glU = null;

    // Amp & pita tetap dihitung di JS (mic FFT / TTS analyser / sintetis).
    var amp = 0.06, ampTarget = 0.06;
    var band = { bass: 0, mid: 0, treb: 0 };
    var moodVal = 0, moodAro = 0;   // suasana hati Aether (polling /mood)
    var audioCtx = null, micAnalyser = null, ttsAnalyser = null, freqBins = null;

    function ensureAudioCtx() {
        if (!audioCtx) {
            try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch (e) {}
        }
        return audioCtx;
    }

    function attachTtsAnalyser(audioEl) {
        try {
            var c = ensureAudioCtx();
            if (!c) return null;
            var src = c.createMediaElementSource(audioEl);
            var an = c.createAnalyser();
            an.fftSize = 256; an.smoothingTimeConstant = 0.72;
            src.connect(an); an.connect(c.destination);
            ttsAnalyser = an;
            return an;
        } catch (e) { return null; }
    }

    function readBands() {
        var an = (mode === "listening" && micAnalyser) ? micAnalyser : ttsAnalyser;
        if (!an) return;
        if (!freqBins || freqBins.length !== an.frequencyBinCount) {
            freqBins = new Uint8Array(an.frequencyBinCount);
        }
        an.getByteFrequencyData(freqBins);
        var avg = function (a, b) {
            var s = 0, n = 0, k;
            for (k = a; k < b && k < freqBins.length; k++) { s += freqBins[k]; n++; }
            return n ? s / n / 255 : 0;
        };
        band.bass += (avg(1, 8)   - band.bass) * 0.35;
        band.mid  += (avg(8, 30)  - band.mid)  * 0.35;
        band.treb += (avg(30, 90) - band.treb) * 0.30;
    }

    function idleAmp() { return 0.06; }

    function initGL() {

        if (!gl) return false;

        var vsSrc = "attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }";
        var fsSrc = document.getElementById("frag").textContent;

        function sh(type, src) {
            var s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.warn("shader:", gl.getShaderInfoLog(s));
                return null;
            }
            return s;
        }

        var vs = sh(gl.VERTEX_SHADER, vsSrc);
        var fs = sh(gl.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return false;

        var prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
        gl.useProgram(prog);

        // fullscreen triangle
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        var locA = gl.getAttribLocation(prog, "a");
        gl.enableVertexAttribArray(locA);
        gl.vertexAttribPointer(locA, 2, gl.FLOAT, false, 0, 0);

        glU = {
            res:   gl.getUniformLocation(prog, "u_res"),
            time:  gl.getUniformLocation(prog, "u_time"),
            amp:   gl.getUniformLocation(prog, "u_amp"),
            bass:  gl.getUniformLocation(prog, "u_bass"),
            mid:   gl.getUniformLocation(prog, "u_mid"),
            treb:  gl.getUniformLocation(prog, "u_treb"),
            val:   gl.getUniformLocation(prog, "u_val"),
            aro:   gl.getUniformLocation(prog, "u_aro"),
            mode:  gl.getUniformLocation(prog, "u_mode")
        };

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        glProg = prog;
        return true;

    }

    var MODE_ID = { idle: 0, listening: 1, thinking: 2, speaking: 3 };

    function drawOrb() {

        var t = Date.now() / 1000;

        amp += (ampTarget - amp) * 0.09;

        if (mode === "thinking") ampTarget = 0.22 + Math.abs(Math.sin(t * 2.7)) * 0.18;
        else if (mode === "idle") ampTarget = idleAmp() + Math.sin(t * 1.3) * 0.02;

        readBands();

        if (glProg) {

            canvas.width  = canvas.clientWidth  * (window.devicePixelRatio > 1.5 ? 1.5 : 1);
            canvas.height = canvas.clientHeight * (canvas.width / canvas.clientWidth || 1);
            gl.viewport(0, 0, canvas.width, canvas.height);

            gl.uniform2f(glU.res, canvas.width, canvas.height);
            gl.uniform1f(glU.time, t);
            gl.uniform1f(glU.amp, Math.min(1, amp));
            gl.uniform1f(glU.bass, band.bass);
            gl.uniform1f(glU.mid,  band.mid);
            gl.uniform1f(glU.treb, band.treb);
            gl.uniform1f(glU.val, moodVal);
            gl.uniform1f(glU.aro, moodAro);
            gl.uniform1f(glU.mode, MODE_ID[mode] ?? 0);

            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

        }

        requestAnimationFrame(drawOrb);

    }

    if (!initGL()) {
        // WebGL tak tersedia → fallback CSS orb.
        canvas.style.display = "none";
        $("orbFallback").style.display = "block";
        ampTarget = 0.3;              // fallback: denyut CSS tetap hidup
    }

    drawOrb();


    // ================= LOG & MEDIA =================
    function addMsg(role, text) {
        var el = document.createElement("div");
        el.className = "msg " + role;
        el.textContent = text;
        logEl.appendChild(el);
        logEl.scrollTop = logEl.scrollHeight;
        return el;
    }

    $("btn-log").addEventListener("click", function () {
        var w = $("chatwrap");
        w.classList.toggle("open");
        if (w.classList.contains("open")) { logEl.classList.remove("hidden"); $("say").focus(); }
    });

    function withToken(url) {
        if (!token) return url;
        return url + (url.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
    }

    function renderMedia(bubble, text) {

        var m, re, found = false;

        re = /!\\[[^\\]]*\\]\\(([^)\\s]+)[^)]*\\)/g;
        while ((m = re.exec(text)) !== null) { appendImg(bubble, m[1]); found = true; }

        re = /data:image\\/[a-z+]+;base64,[A-Za-z0-9+\\/=]{100,}/g;
        while ((m = re.exec(text)) !== null) { appendImg(bubble, m[0]); found = true; }

        re = /https?:\\/\\/[^\\s"'<>]+\\.(?:jpe?g|png|gif|webp)(?:\\?[^\s"'<>]*)?/gi;
        while ((m = re.exec(text)) !== null) { appendImg(bubble, m[0]); found = true; }

        re = /companion\\/media\\/[A-Za-z0-9_-]+\\.[a-z0-9]{1,6}/g;
        while ((m = re.exec(text)) !== null) { appendFile(bubble, m[0]); found = true; }

        return found;

    }

    function appendImg(bubble, src) {
        var img = document.createElement("img");
        img.src = src.indexOf("data:") === 0 ? src : withToken(src);
        img.loading = "lazy";
        img.addEventListener("click", function () { window.open(img.src, "_blank"); });
        bubble.appendChild(img);
    }

    function appendFile(bubble, href) {
        var a = document.createElement("a");
        a.className = "chipfile";
        a.href = withToken(href.indexOf("/") === 0 ? href : "/" + href);
        a.target = "_blank";
        a.textContent = "[berkas] " + href.split("/").pop();
        bubble.appendChild(a);
    }

    // ================= TTS =================
    var currentAudio = null;

    function pickVoice() {
        try {
            var vs = speechSynthesis.getVoices();
            for (var k = 0; k < vs.length; k++) if (/^id/i.test(vs[k].lang)) return vs[k];
        } catch (e) {}
        return null;
    }

    function idleAmp() { return 0.06; }

    function speakText(text) {

        if (settings.ttsMode === "off" || !text) return Promise.resolve();

        if (settings.ttsMode === "server") return speakServer(text);

        // Browser TTS: tak ada node audio — orb pakai envelope sintetis.
        return new Promise(function (resolve) {
            try {
                var u = new SpeechSynthesisUtterance(text);
                u.lang = "id-ID"; u.rate = Number(settings.rate) || 1;
                var v = pickVoice(); if (v) u.voice = v;
                u.onstart = function () { setMode("speaking"); };
                u.onboundary = function () { ampTarget = 0.35 + Math.random() * 0.4; };
                u.onend = u.onerror = function () { ampTarget = idleAmp(); resolve(); };
                speechSynthesis.speak(u);
            } catch (e) { resolve(); }
        });
    }

    function speakServer(text) {

        return fetch("/api/v1/companion/tts", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ text: text })
        })
        .then(function (r) { if (!r.ok) throw new Error("TTS server gagal"); return r.blob(); })
        .then(function (blob) {
            return new Promise(function (resolve) {
                var url = URL.createObjectURL(blob);
                var au = new Audio(url);
                currentAudio = au;
                attachTtsAnalyser(au);          // orb menari mengikuti audio asli
                au.onended = au.onerror = function () {
                    URL.revokeObjectURL(url); currentAudio = null;
                    ttsAnalyser = null; ampTarget = idleAmp(); resolve();
                };
                setMode("speaking"); ampTarget = 0.5;
                au.play().catch(function () { resolve(); });
            });
        })
        .catch(function () { /* TTS gagal → diam */ });

    }

    function stopSpeaking() {
        try { speechSynthesis.cancel(); } catch (e) {}
        if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
        ttsAnalyser = null;
    }

    // ================= STT — TAHAN ORB (PTT) =================
    var micStream = null, micAnalyser = null, micRAF = null;
    var recog = null, recorder = null, recChunks = [];
    var lastVoiceAt = 0;

    function micLevelLoop() {
        var bins = new Uint8Array(micAnalyser.frequencyBinCount);
        function tick() {
            if (!micAnalyser || mode !== "listening") { micRAF = null; return; }
            micAnalyser.getByteFrequencyData(bins);
            var s = 0, k, n = Math.min(40, bins.length);
            for (k = 1; k < n; k++) s += bins[k];
            var lvl = s / (n * 255);
            ampTarget = Math.min(1, 0.14 + lvl * 2.4);   // ekualiser: orb ikut suara
            if (lvl > 0.055) lastVoiceAt = Date.now();
            micRAF = requestAnimationFrame(tick);
        }
        tick();
    }

    function stopMic() {
        if (micRAF) cancelAnimationFrame(micRAF);
        if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
        micStream = null; micAnalyser = null;
        clearTimeout(window.__pttGuard);
        clearInterval(window.__pttVad);
    }

    async function pttStart() {

        if (busy || !token) return;

        stopSpeaking();                                  // barge-in

        if (!window.isSecureContext) {
            setStatus("MIC BUTUH HTTPS");
            setHint("di PC jalankan:  tailscale serve 3000");
            setTimeout(function () { setMode("idle"); }, 2600);
            return;
        }

        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            setStatus("MIC DITOLAK");
            setHint("izinkan mikrofon untuk halaman ini");
            setTimeout(function () { setMode("idle"); }, 2200);
            return;
        }

        var c = ensureAudioCtx();
        if (c && c.state === "suspended") { try { c.resume(); } catch (e) {} }
        var src = c.createMediaStreamSource(micStream);
        micAnalyser = c.createAnalyser();
        micAnalyser.fftSize = 256;
        micAnalyser.smoothingTimeConstant = 0.68;
        src.connect(micAnalyser);

        setMode("listening");
        setHint("lepas untuk kirim");
        lastVoiceAt = Date.now();
        micLevelLoop();

        var finalText = "";

        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (SR) {

            recog = new SR();
            recog.lang = "id-ID"; recog.interimResults = true; recog.continuous = false;

            recog.onresult = function (ev) {
                var fin = "", k;
                for (k = ev.resultIndex; k < ev.results.length; k++) {
                    if (ev.results[k].isFinal) finalText += ev.results[k][0].transcript;
                }
            };

            recog.onend = function () {
                var wasHolding = holding;
                stopMic();
                if (finalText.trim()) { send(finalText.trim()); }
                else if (!wasHolding) setMode("idle");
                else setMode("idle");
            };

            try { recog.start(); } catch (e) { /* fallback di bawah */ }
            return;
        }

        // Fallback: MediaRecorder.
        try {
            recChunks = [];
            recorder = new MediaRecorder(micStream);
            recorder.ondataavailable = function (e) { if (e.data.size) recChunks.push(e.data); };
            recorder.onstop = function () {

                stopMic();

                var blob = new Blob(recChunks, { type: (recorder && recorder.mimeType) || "audio/webm" });
                if (blob.size < 1200) { setMode("idle"); return; }

                setMode("thinking");

                var fr = new FileReader();
                fr.onload = function () {
                    fetch("/api/v1/companion/transcribe", {
                        method: "POST",
                        headers: authHeaders({ "Content-Type": "application/json" }),
                        body: JSON.stringify({
                            audio: String(fr.result).split(",")[1],
                            mimeType: blob.type, language: "id"
                        })
                    })
                    .then(function (r) { return r.json(); })
                    .then(function (d) {
                        var txt = ((d && d.data && d.data.text) || "").trim();
                        if (txt) send(txt); else setMode("idle");
                    })
                    .catch(function () { setMode("idle"); });
                };
                fr.readAsDataURL(blob);

            };
            recorder.start();

            // Jaring pengaman VAD (bila pemilik menahan terlalu lama tanpa suara).
            window.__pttVad = setInterval(function () {
                if (Date.now() - lastVoiceAt > 6000 && recorder && recorder.state === "recording") {
                    clearInterval(window.__pttVad);
                    recorder.stop();
                }
            }, 300);

        } catch (e) { stopMic(); setMode("idle"); }

    }

    function pttStop() {

        holding = false;

        if (recog) { try { recog.stop(); } catch (e) {} return; }   // onend mengirim
        if (recorder && recorder.state === "recording") { recorder.stop(); return; }

        stopMic(); setMode("idle");

    }

    // Tahan orb = PTT
    canvas.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        if (mode === "speaking" || busy) return;
        holding = true;
        pttStart();
    });

    ["pointerup", "pointercancel", "pointerleave"].forEach(function (evName) {
        canvas.addEventListener(evName, function () {
            if (holding) pttStop();
        });
    });

    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    // ================= KIRIM (streaming SSE) =================
    function send(text) {

        text = String(text || "").trim();
        if (!text || busy || !token) return;

        busy = true;
        stopSpeaking();
        addMsg("user", text);
        setMode("thinking");

        var bubble = addMsg("aether", "");
        bubble.innerHTML = '<span class="caret"></span>';
        var acc = "";

        fetch("/api/v1/companion/chat/stream", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ text: text })
        }).then(function (res) {

            if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); location.reload(); return null; }
            if (!res.ok) throw new Error("HTTP " + res.status);
            if (!res.body) throw new Error("stream tak tersedia");

            var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";

            function pump() {
                return reader.read().then(function (r) {

                    if (r.done) return;

                    buf += dec.decode(r.value, { stream: true });
                    var frames = buf.split("\\n\\n");
                    buf = frames.pop();

                    frames.forEach(function (fr) {

                        var ev = "message", dataLines = [];
                        fr.split("\\n").forEach(function (ln) {
                            if (ln.indexOf("event:") === 0) ev = ln.slice(6).trim();
                            else if (ln.indexOf("data:") === 0) dataLines.push(ln.slice(5).trim());
                        });
                        if (!dataLines.length) return;

                        var d; try { d = JSON.parse(dataLines.join("\\n")); } catch (e) { return; }

                        if (ev === "chunk" && d.delta) {
                            acc += d.delta;
                            bubble.textContent = acc;
                            logEl.scrollTop = logEl.scrollHeight;
                            ampTarget = Math.min(0.75, 0.16 + (acc.length % 37) / 70);
                        }
                        else if (ev === "error") {
                            acc += "\\n[gagal: " + (d.message || "?") + "]";
                            bubble.textContent = acc;
                        }
                    });

                    return pump();
                });
            }

            return pump();

        })
        .catch(function (e) {
            acc = acc || ("[gagal: " + e.message + "]");
            bubble.textContent = acc;
        })
        .finally(function () {

            busy = false;

            if (!acc.trim()) { bubble.textContent = "(tidak ada jawaban)"; acc = "(tidak ada jawaban)"; }
            else bubble.textContent = acc;

            renderMedia(bubble, acc);
            logEl.scrollTop = logEl.scrollHeight;

            var parts = acc.split(/(?<=[.!?\\n])\\s+/);
            var chain = Promise.resolve();
            parts.forEach(function (p) {
                p = p.replace(/^\\s+/, "");
                if (!p) return;
                chain = chain.then(function () { return speakText(p); });
            });
            chain.then(function () { setMode("idle"); ampTarget = idleAmp(); });

        });

    }

    $("btn-send").addEventListener("click", function () { send($("say").value); $("say").value = ""; });
    $("say").addEventListener("keydown", function (e) {
        if (e.key === "Enter") { send($("say").value); $("say").value = ""; }
    });

    // ================= LAMPIRAN =================
    $("btn-att").addEventListener("click", function () { $("file").click(); });

    $("file").addEventListener("change", function () {

        var f = this.files[0];
        this.value = "";
        if (!f || !token) return;

        if (f.size > 10 * 1024 * 1024) { setStatus("BERKAS > 10MB"); return; }

        setMode("thinking");
        addMsg("user", "[lampiran] " + f.name);

        var fr = new FileReader();
        fr.onload = function () {

            fetch("/api/v1/companion/upload", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ name: f.name, data: String(fr.result).split(",")[1], mimeType: f.type })
            })
            .then(function (r) { return r.json(); })
            .then(function (d) {

                var saved = d && d.data;
                if (!saved || !saved.url) throw new Error((d && d.message) || "upload gagal");

                if (/^image\//i.test(saved.mimeType || "")) {
                    var last = logEl.querySelector(".msg.user:last-child") || logEl.lastElementChild;
                    appendImg(last, saved.url);
                    logEl.scrollTop = logEl.scrollHeight;
                }

                send("[Device mengirim lampiran \\"" + saved.name + "\\". Berkas tersimpan di path server: " +
                     saved.path + ". Pengguna mungkin akan bertanya soal isinya.]");

            })
            .catch(function (e) {
                setStatus("UPLOAD GAGAL");
                addMsg("aether", "[gagal unggah: " + e.message + "]");
                setMode("idle");
            });

        };
        fr.readAsDataURL(f);

    });

    // ================= SETTINGS =================
    function renderTtsSeg() {
        document.querySelectorAll("#tts-seg button").forEach(function (b) {
            b.classList.toggle("on", b.dataset.v === settings.ttsMode);
        });
        $("rate").disabled = settings.ttsMode !== "browser";
    }

    /** Muat konfigurasi otak AI penuh (provider+url+key mask+model). */
    var aiCfg = null;   // hasil /ai/config

    async function loadAiSettings() {

        var selP = $("set-provider"), urlI = $("set-url"),
            keyI = $("set-key"), mI = $("set-model-text");

        selP.innerHTML = "<option value=''>memuat…</option>";

        try {

            var r = await fetch("/api/v1/companion/ai/config", { headers: authHeaders() });
            aiCfg = await r.json();

            var cfg = (aiCfg && aiCfg.data) || {};
            var provs = cfg.providers || {};

            selP.innerHTML = "";
            Object.keys(provs).forEach(function (id) {
                var o = document.createElement("option");
                o.value = id;
                o.textContent = provs[id].label || id;
                selP.appendChild(o);
            });

            selP.value = cfg.active || "";

            fillProviderFields();
            refreshCurLine(cfg);

        } catch (e) {
            selP.innerHTML = "<option value=''>gagal memuat</option>";
        }

    }

    function refreshCurLine(cfg) {
        var c = cfg || (aiCfg && aiCfg.data) || {};
        $("cur-ai").textContent =
            "aktif: " + (c.active || "-") +
            (c.resolved && c.resolved.model ? " · model: " + c.resolved.model : "");
    }

    /** Isi url/key-hint/model sesuai platform terpilih. */
    function fillProviderFields() {

        var id = $("set-provider").value;
        var provs = (aiCfg && aiCfg.data && aiCfg.data.providers) || {};
        var p = provs[id];
        var isLocal = false;

        if (!p) {   // platform tanpa entri
            $("set-url").value = "";
            $("set-key").value = "";
            $("set-key").placeholder = "tidak perlu key";
            $("set-key").disabled = true;
            $("set-url").placeholder = "https://api.example.com/v1";
            $("set-model-text").value = "";
            $("model-hint").textContent = "";
            return;
        }

        $("set-url").value = p.baseUrl || "";
        $("set-url").placeholder = p.defaultBaseUrl || "";
        $("set-url").disabled = false;

        $("set-key").value = "";                       // tidak pernah dikirim balik
        $("set-key").placeholder = p.hasKey
            ? ("tersimpan (" + (p.keyHint || "••••") + ") — kosongkan biar tetap")
            : "belum ada key";
        $("set-key").disabled = false;

        $("set-model-text").value = p.model || "";
        $("model-hint").textContent = p.modelHint || "";

    }

    $("set-provider").addEventListener("change", function () {
        fillProviderFields();
    });

    $("btn-models").addEventListener("click", async function () {

        var providerId = $("set-provider").value;
        var dl = $("model-list"), hint = $("model-hint");

        hint.textContent = "memuat model…";

        try {
            var mr = await fetch("/api/v1/companion/ai/models?provider=" +
                encodeURIComponent(providerId), { headers: authHeaders() });
            var md = await mr.json();
            var models = (md.data && md.data.models) || [];

            dl.innerHTML = "";
            models.forEach(function (m) {
                var idv = typeof m === "string" ? m : (m.id || m.name);
                if (!idv) return;
                var o = document.createElement("option");
                o.value = idv;
                dl.appendChild(o);
            });

            hint.textContent = models.length + " model tersedia — klik kolom model.";

        } catch (e) {
            hint.textContent = "gagal memuat model";
        }

    });

    $("set-provider").addEventListener("change", function () {
        loadModels(this.value, "");
    });

    $("btn-set").addEventListener("click", function () {
        $("set-name").value = devName;
        $("rate").value = settings.rate;
        renderTtsSeg();
        loadAiSettings();
        $("setbg").classList.add("open");
    });

    $("setbg").addEventListener("click", function (e) {
        if (e.target === $("setbg")) $("setbg").classList.remove("open");
    });

    document.querySelectorAll("#tts-seg button").forEach(function (b) {
        b.addEventListener("click", function () {
            settings.ttsMode = b.dataset.v;
            renderTtsSeg();
        });
    });

    $("rate").addEventListener("input", function () {
        $("rate-val").textContent = this.value;
    });

    $("btn-saveset").addEventListener("click", async function () {

        devName = ($("set-name").value.trim() || "device");
        settings.rate = Number($("rate").value) || 1;

        localStorage.setItem(SET_KEY, JSON.stringify(settings));
        localStorage.setItem(NAME_KEY, devName);

        // Terapkan otak AI: simpan url/key/model, lalu aktifkan.
        try {

            var pid = $("set-provider").value;

            await fetch("/api/v1/companion/ai/config", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    active: pid || undefined,
                    provider: {
                        id: pid || undefined,
                        baseUrl: $("set-url").value.trim() || undefined,
                        apiKey: $("set-key").value.trim() === "" ? undefined : $("set-key").value.trim(),
                        model: $("set-model-text").value.trim() || undefined
                    }
                })
            });

            await fetch("/api/v1/companion/ai/select", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    provider: pid || undefined,
                    model: $("set-model-text").value.trim() || undefined
                })
            });

        } catch (e) { /* setelan suara tetap tersimpan */ }

        $("setbg").classList.remove("open");
        setStatus("TERSIMPAN");
        setTimeout(function () { setMode("idle"); }, 1200);

    });

    $("btn-panic").addEventListener("click", async function () {

        if (($("panic-confirm").value || "").trim() !== "STOP") {
            setStatus("KETIK STOP DULU");
            return;
        }

        try {
            const r = await fetch("/api/v1/companion/panic", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ reason: "panic dari device" })
            });
            const d = await r.json();
            setStatus(d.ok ? "KILL SWITCH AKTIF" : "GAGAL");
        } catch (e) {
            setStatus("GAGAL");
        }

    });

    $("btn-logout").addEventListener("click", function () {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(NAME_KEY);
        location.reload();
    });

    // ================= PAIRING & BOOT =================
    $("code").addEventListener("input", function () {
        this.value = this.value.replace(/\\D/g, "").slice(0, 6);
    });

    $("btn-join").addEventListener("click", async function () {

        var code = $("code").value.trim();
        var name = $("dev-name").value.trim() || "device";

        if (code.length !== 6) { $("err").textContent = "Masukkan kode 6 digit."; return; }

        $("btn-join").disabled = true;
        $("err").textContent = "";
        setStatus("CONNECTING…");

        try {

            var res = await fetch("/api/v1/companion/join", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: code, name: name })
            });

            var data = await res.json();

            if (!res.ok || !data.data.token) throw new Error(data.message || "Pairing gagal.");

            localStorage.setItem(TOKEN_KEY, data.data.token);
            localStorage.setItem(NAME_KEY, data.data.name);
            location.reload();

        } catch (e) {
            $("err").textContent = e.message;
            setStatus("LINK…");
        } finally {
            $("btn-join").disabled = false;
        }

    });

    if (token) {
        setMode("idle");
        setInterval(async () => {
            try {
                const r = await fetch("/api/v1/companion/mood", {
                    headers: authHeaders()
                });
                const d = await r.json();
                if (d && d.data) {
                    moodVal = Number(d.data.valence) || 0;
                    moodAro = Math.max(0, Number(d.data.arousal) || 0);
                }
            } catch (e) { /* diam */ }
        }, 30000);
    } else {
        $("pair-view").style.display = "flex";
        setStatus("LINK…");
    }

})();
</script>

</body>
</html>`;

}

module.exports = { html };
