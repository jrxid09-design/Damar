/*
 * view.js — mode UI Mata Dewa (satu layar di aplikasi Damar yang SAMA).
 *
 * Ini permukaan, bukan aplikasi kedua. Inti headless (provider → observasi →
 * fusion → watch → alert) berjalan di daemon Damar dan tetap hidup saat layar
 * ini ditutup. Aktivasi ("Damar, aktifkan mode Mata Dewa") menavigasi aplikasi
 * yang ada ke layar ini; "Damar, kembali" pulang ke Beranda.
 */

import { api } from "../../lib/api.js";
import { icon } from "../../lib/icons.js";
import { toast } from "../../lib/ui.js";
import * as globe from "./globe.js";
import { mountHud } from "./hud.js";

let hud = null;
let pollTimer = null;
let lastObservations = [];

const LAYER_TOGGLES = [
  { type: "earthquake", label: "Gempa (USGS)" },
  { type: "satellite", label: "Satelit (CelesTrak)" },
  { type: "flight", label: "Penerbangan (adsb.lol)" },
  { type: "weather", label: "Cuaca (Open-Meteo)" },
];

async function fetchJson(path) { return api.request(path, { method: "GET" }); }

async function refreshState(root) {
  try {
    const surface = await fetchJson("/matadewa/surface");
    const modeEl = root.querySelector("#md-mode");
    if (modeEl) modeEl.textContent = surface.mode ?? "ZERO";
    const available = (surface.providers || []).filter(p => p.availability === "available").length;
    hud?.setState({
      mode: surface.mode ?? "ZERO",
      providers: `${available}/${(surface.providers || []).length}`,
      obs: String((surface.observations || []).length),
    });
    renderProviderPanel(root, surface.providers || []);
    return surface;
  } catch (error) {
    hud?.setState({ mode: "OFFLINE", providers: "—", obs: "—" });
    return null;
  }
}

function renderProviderPanel(root, providers) {
  const host = root.querySelector("#md-providers");
  if (!host) return;
  host.innerHTML = providers.map(p => `
    <div class="md-provider">
      <span class="md-dot md-${p.availability}"></span>
      <span class="md-pname">${escapeHtml(p.label)}</span>
      <span class="md-pmeta">${p.accessMode}${p.requiresCredential ? " · " + (p.credentialTier ?? "") : ""}</span>
      ${p.failureReason ? `<span class="md-pfail">${escapeHtml(p.failureReason)}</span>` : ""}
    </div>`).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadLayer(root, type) {
  try {
    const result = await api.request("/matadewa/ask", {
      method: "POST",
      body: { types: [type] },
    });
    return result.observations || [];
  } catch (error) {
    toast(`Lapisan ${type} gagal: ${error.message}`, "err");
    return [];
  }
}

async function reloadActiveLayers(root) {
  const active = LAYER_TOGGLES
    .filter(t => root.querySelector(`#md-layer-${t.type}`)?.checked)
    .map(t => t.type);
  const all = [];
  for (const type of active) {
    all.push(...await loadLayer(root, type));
  }
  lastObservations = all;
  const count = globe.renderObservations(all);
  const countEl = root.querySelector("#md-count");
  if (countEl) countEl.textContent = `${count} entitas`;
  refreshState(root);
}

function buildLayout(root) {
  root.innerHTML = `
    <div class="md-root">
      <div class="md-globe" id="md-globe"></div>
      <div class="md-hud-host" id="md-hud"></div>

      <div class="md-rail md-rail-left">
        <div class="md-panel">
          <div class="md-panel-head">${icon("orb")} <b>Mata Dewa</b> <span class="md-mode" id="md-mode">ZERO</span></div>
          <div class="md-panel-sub">${icon("activity")} <span id="md-count">0 entitas</span></div>
        </div>
        <div class="md-panel">
          <div class="md-panel-head">${icon("grid")} Lapisan</div>
          ${LAYER_TOGGLES.map(t => `
            <label class="md-toggle">
              <input type="checkbox" id="md-layer-${t.type}" />
              <span>${escapeHtml(t.label)}</span>
            </label>`).join("")}
          <button class="btn sm ghost" id="md-reload" style="margin-top:8px">${icon("refresh")} Muat</button>
        </div>
        <div class="md-panel">
          <div class="md-panel-head">${icon("camera")} Tampilan</div>
          <div class="md-row" id="md-styles"></div>
        </div>
      </div>

      <div class="md-rail md-rail-right">
        <div class="md-panel">
          <div class="md-panel-head">${icon("server")} Provider</div>
          <div id="md-providers" class="md-providers"></div>
        </div>
        <div class="md-panel">
          <div class="md-panel-head">${icon("alert")} Peta Dasar</div>
          <div class="md-row" id="md-stacks"></div>
        </div>
      </div>
    </div>`;
}

function wireControls(root) {
  root.querySelector("#md-reload")?.addEventListener("click", () => reloadActiveLayers(root));
  for (const t of LAYER_TOGGLES) {
    root.querySelector(`#md-layer-${t.type}`)?.addEventListener("change", () => reloadActiveLayers(root));
  }

  // Gaya visual.
  const stylesHost = root.querySelector("#md-styles");
  if (stylesHost) {
    const styles = window.MataDewaStyles?.listStyles?.() ?? ["normal"];
    stylesHost.innerHTML = styles.map(s =>
      `<button class="btn sm ghost md-style" data-style="${s}">${s}</button>`).join("");
    stylesHost.querySelectorAll(".md-style").forEach(btn => {
      btn.addEventListener("click", () => {
        window.MataDewaStyles?.setVisualStyle(globe.getViewer(), btn.dataset.style);
      });
    });
  }

  // Basemap.
  const stacksHost = root.querySelector("#md-stacks");
  if (stacksHost) {
    const stacks = globe.getMapStack()?.getStacks?.() ?? [];
    stacksHost.innerHTML = stacks.map(s =>
      `<button class="btn sm ghost md-stack" data-stack="${s.id}" ${s.available ? "" : "disabled"} title="${s.available ? "" : "butuh token"}">${s.shortLabel}</button>`).join("");
    stacksHost.querySelectorAll(".md-stack").forEach(btn => {
      btn.addEventListener("click", async () => {
        const r = await globe.setStack(btn.dataset.stack);
        if (!r.ok) toast(`Basemap: ${r.reason}`, "warn");
      });
    });
  }
}

export const mataDewa = {
  id: "mata-dewa",
  label: "Mata Dewa",
  icon: "activity",
  title: "Mata Dewa",
  subtitle: "Kecerdasan spasial Damar — globe, lapisan, aset & bahaya.",

  render(root) {
    buildLayout(root);
  },

  async mount(root) {
    // Muat gaya dulu (modul IIFE), baru globe.
    await import("./lib/styles.js");
    try {
      const status = await fetchJson("/matadewa/status").catch(() => null);
      const tokens = status?.tokens ?? {};
      await globe.initGlobe(root.querySelector("#md-globe"), { tokens });
    } catch (error) {
      const host = root.querySelector("#md-globe");
      if (host) host.innerHTML = `<div class="md-globe-fallback">Globe gagal dimuat: ${escapeHtml(error.message)}</div>`;
    }
    hud = mountHud(root.querySelector("#md-hud"));
    wireControls(root);
    await refreshState(root);
    await reloadActiveLayers(root);
    // Poll ringan untuk status/observasi segar (permukaan saja; inti headless).
    pollTimer = setInterval(() => reloadActiveLayers(root), 30000);
  },

  unmount() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    hud?.dispose();
    hud = null;
    // Globe dibersihkan agar sumber daya GPU dibebaskan; inti headless tetap hidup.
    globe.destroyGlobe();
    lastObservations = [];
  },
};
