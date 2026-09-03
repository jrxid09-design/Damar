/*
 * hud.js — HUD Mata Dewa milik Damar (konsep dari GEV hud.js, di-re-own).
 *
 * Menampilkan koordinat kamera, ketinggian, status epistemik observasi,
 * jumlah provider/observasi, dan mode. Tidak mengimpor modul voice mana pun.
 * Diperbarui pada cadence ringan; baca state dari globe + service (daemon).
 */

import { getViewer } from "./globe.js";

function fmtCoord(deg, isLat) {
  if (!Number.isFinite(deg)) return "—";
  const dir = isLat ? (deg >= 0 ? "N" : "S") : (deg >= 0 ? "E" : "W");
  return `${Math.abs(deg).toFixed(4)}° ${dir}`;
}

function fmtAlt(m) {
  if (!Number.isFinite(m)) return "—";
  if (m >= 1000000) return `${(m / 1000000).toFixed(1)} Mm`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

/** Pasang HUD ke elemen container; mengembalikan handle update/destroy. */
export function mountHud(container) {
  container.innerHTML = `
    <div class="md-hud md-hud-tl">
      <div class="md-hud-row"><span class="md-k">MODE</span><span class="md-v" data-md="mode">—</span></div>
      <div class="md-hud-row"><span class="md-k">PROVIDER</span><span class="md-v" data-md="providers">—</span></div>
      <div class="md-hud-row"><span class="md-k">OBS</span><span class="md-v" data-md="obs">—</span></div>
    </div>
    <div class="md-hud md-hud-bl">
      <div class="md-hud-row"><span class="md-k" data-md="lat">—</span> <span class="md-k" data-md="lon">—</span></div>
      <div class="md-hud-row"><span class="md-k">ALT</span><span class="md-v" data-md="alt">—</span></div>
      <div class="md-hud-row"><span class="md-k md-dim" data-md="clock">—</span></div>
    </div>`;

  const el = (name) => container.querySelector(`[data-md="${name}"]`);
  let disposed = false;
  let removeListener = null;

  function setState({ mode, providers, obs }) {
    if (disposed) return;
    if (el("mode")) el("mode").textContent = mode ?? "—";
    if (el("providers")) el("providers").textContent = providers ?? "—";
    if (el("obs")) el("obs").textContent = obs ?? "—";
  }

  function tick() {
    if (disposed) return;
    const viewer = getViewer();
    if (viewer && window.Cesium && !viewer.isDestroyed()) {
      const carto = viewer.camera.positionCartographic;
      if (carto) {
        const lat = window.Cesium.Math.toDegrees(carto.latitude);
        const lon = window.Cesium.Math.toDegrees(carto.longitude);
        if (el("lat")) el("lat").textContent = fmtCoord(lat, true);
        if (el("lon")) el("lon").textContent = fmtCoord(lon, false);
        if (el("alt")) el("alt").textContent = fmtAlt(carto.height);
      }
    }
    if (el("clock")) {
      el("clock").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
    }
  }

  const timer = setInterval(tick, 500);
  tick();

  return {
    setState,
    dispose() {
      disposed = true;
      clearInterval(timer);
      if (typeof removeListener === "function") removeListener();
    },
  };
}
