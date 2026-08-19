/**
 * HandTracker — kontrol gestur tangan (webcam) untuk Console Aether.
 *
 * Diadaptasi dari Ultron (SAGAR-TAMANG/ultron-by-sagar-builds,
 * lib/handTracker.ts, MIT). Pinch 1 tangan = putar; pinch 2 tangan
 * merenggang/merapat = zoom. Histeresis mencegah kedip di ambang.
 *
 * Beda dari asli:
 *  - Vanilla JS (bukan TS), ES module Console.
 *  - MediaPipe di-LAZY import saat start() — modul ini bisa dimuat di
 *    Node untuk menguji matematikanya tanpa DOM/WebGL.
 *  - Aset (WASM+model) bisa dilokalkan; default CDN.
 *    ponytail: CDN default. Vendor lokal untuk offline penuh bila perlu.
 */

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MP_ESM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm";

// Indeks landmark model tangan MediaPipe.
export const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9;

// Histeresis pinch: jarak jempol–telunjuk relatif ukuran tangan.
export const PINCH_ON = 0.32;
export const PINCH_OFF = 0.45;

export const ROTATE_SPEED = 5.0;
export const SMOOTHING = 0.4;
export const ZOOM_MIN = 0.85, ZOOM_MAX = 1.18;

// ---- Fungsi murni (teruji tanpa DOM) -------------------------------

export function dist2d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Histeresis: kembalikan status pinch berikutnya dari status kini + rasio. */
export function applyHysteresis(pinching, ratio) {
    if (pinching && ratio > PINCH_OFF) return false;
    if (!pinching && ratio < PINCH_ON) return true;
    return pinching;
}

/** Mode dari jumlah tangan yang mencubit. */
export function computeMode(pinchCount) {
    return pinchCount >= 2 ? "zoom" : pinchCount === 1 ? "spin" : "idle";
}

/** Faktor zoom terklamp dari jarak dua grab (renggang → <1 → mendekat). */
export function clampZoom(prevDist, d) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prevDist / d));
}

// ---- Kelas tracker (butuh DOM + MediaPipe) -------------------------

export class HandTracker {
    /**
     * @param {HTMLVideoElement} video
     * @param {HTMLCanvasElement} overlay
     * @param {{onRotate:Function,onZoom:Function,onStatus:Function}} callbacks
     * @param {{wasm?:string,model?:string,esm?:string}} [assets]
     */
    constructor(video, overlay, callbacks, assets = {}) {
        this.video = video;
        this.overlay = overlay;
        this.callbacks = callbacks;
        this.assets = { wasm: assets.wasm || WASM_CDN, model: assets.model || MODEL_URL, esm: assets.esm || MP_ESM };
        this.landmarker = null;
        this.stream = null;
        this.rafId = 0;
        this.running = false;
        this.lastVideoTime = -1;
        this.handStates = new Map();
        this.prevMode = "idle";
        this.prevSpinGrab = null;
        this.prevZoomDist = null;
        this.lastStatus = { hands: 0, mode: "idle" };
        this._loop = this._loop.bind(this);
    }

    async start() {
        this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: "user" }, audio: false
        });
        this.video.srcObject = this.stream;
        await this.video.play();

        const { FilesetResolver, HandLandmarker } = await import(this.assets.esm);
        const fileset = await FilesetResolver.forVisionTasks(this.assets.wasm);
        const options = {
            baseOptions: { modelAssetPath: this.assets.model, delegate: "GPU" },
            runningMode: "VIDEO", numHands: 2,
            minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6
        };
        try {
            this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
        } catch {
            this.landmarker = await HandLandmarker.createFromOptions(fileset, {
                ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" }
            });
        }
        this.running = true;
        this._loop();
    }

    stop() {
        this.running = false;
        cancelAnimationFrame(this.rafId);
        this.landmarker?.close();
        this.landmarker = null;
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        if (this.video) this.video.srcObject = null;
        this.handStates.clear();
        this.prevMode = "idle"; this.prevSpinGrab = null; this.prevZoomDist = null;
        this.overlay?.getContext("2d")?.clearRect(0, 0, this.overlay.width, this.overlay.height);
        this._emit({ hands: 0, mode: "idle" });
    }

    _loop() {
        if (!this.running) return;
        this.rafId = requestAnimationFrame(this._loop);
        if (!this.landmarker || this.video.readyState < 2) return;
        if (this.video.currentTime === this.lastVideoTime) return;
        this.lastVideoTime = this.video.currentTime;

        const result = this.landmarker.detectForVideo(this.video, performance.now());
        this._process(result.landmarks, result.handedness.map(h => h[0]?.categoryName ?? "?"));
        this._draw(result.landmarks);
    }

    _process(landmarks, labels) {
        const pinchedGrabs = [];
        const seen = new Set();

        landmarks.forEach((lm, i) => {
            const label = labels[i];
            seen.add(label);
            const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
            if (handScale < 1e-6) return;
            const ratio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;
            const raw = { x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2, y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2 };

            let st = this.handStates.get(label);
            if (!st) { st = { pinching: false, grab: raw }; this.handStates.set(label, st); }
            st.pinching = applyHysteresis(st.pinching, ratio);
            st.grab = { x: st.grab.x + (raw.x - st.grab.x) * SMOOTHING, y: st.grab.y + (raw.y - st.grab.y) * SMOOTHING };
            if (st.pinching) pinchedGrabs.push(st.grab);
        });

        for (const key of this.handStates.keys()) if (!seen.has(key)) this.handStates.delete(key);

        const mode = computeMode(pinchedGrabs.length);
        if (mode !== this.prevMode) { this.prevSpinGrab = null; this.prevZoomDist = null; this.prevMode = mode; }

        if (mode === "spin") {
            const grab = pinchedGrabs[0];
            if (this.prevSpinGrab) {
                const dx = grab.x - this.prevSpinGrab.x, dy = grab.y - this.prevSpinGrab.y;
                if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
            }
            this.prevSpinGrab = grab;
        } else if (mode === "zoom") {
            const d = Math.hypot(pinchedGrabs[0].x - pinchedGrabs[1].x, pinchedGrabs[0].y - pinchedGrabs[1].y);
            if (this.prevZoomDist && d > 1e-4) this.callbacks.onZoom(clampZoom(this.prevZoomDist, d));
            this.prevZoomDist = d;
        }

        this._emit({ hands: landmarks.length, mode });
    }

    _emit(status) {
        if (status.hands !== this.lastStatus.hands || status.mode !== this.lastStatus.mode) {
            this.lastStatus = status;
            this.callbacks.onStatus(status);
        }
    }

    _draw(landmarks) {
        const ctx = this.overlay?.getContext("2d");
        if (!ctx) return;
        const { width, height } = this.overlay;
        ctx.clearRect(0, 0, width, height);
        for (const lm of landmarks) {
            const thumb = lm[THUMB_TIP], index = lm[INDEX_TIP];
            const tx = (1 - thumb.x) * width, ty = thumb.y * height;
            const ix = (1 - index.x) * width, iy = index.y * height;
            const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
            const pinched = handScale > 1e-6 && dist2d(thumb, index) / handScale < PINCH_ON;
            ctx.strokeStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.5)";
            ctx.lineWidth = pinched ? 2 : 1;
            ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ix, iy); ctx.stroke();
            ctx.fillStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.7)";
            for (const [x, y] of [[tx, ty], [ix, iy]]) { ctx.beginPath(); ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2); ctx.fill(); }
        }
    }
}
