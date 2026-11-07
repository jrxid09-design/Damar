/*
 * globe.js — bootstrap Cesium untuk permukaan Mata Dewa (Damar).
 *
 * Memakai Cesium IIFE tervendor (window.Cesium). Basemap default KEYLESS
 * (Esri imagery → OSM fallback); Google 3D/photoreal hanya bila token Damar
 * tersedia. Mata Dewa berjalan pada akselerasi browser/GPU yang tersedia,
 * tetapi inti headless-nya tidak bergantung GPU kelas atas.
 */

import { loadCesium } from "./lib/cesiumLoader.js";

const ESRI_FALLBACK_CAMERA = { lat: -2.5, lon: 118.0, alt: 22000000 }; // Indonesia, globe view

let viewer = null;
let mapStack = null;
let entityLayer = null;
let trackedEntityId = null;

function creditContainer(doc) {
  let el = doc.getElementById("md-cesium-credits");
  if (!el) {
    el = doc.createElement("div");
    el.id = "md-cesium-credits";
    doc.body.appendChild(el);
  }
  return el;
}

/** Inisialisasi (idempoten). Mengembalikan viewer atau melempar error. */
export async function initGlobe(container, { tokens = {} } = {}) {
  if (viewer) return viewer;
  const Cesium = await loadCesium();
  if (!Cesium) throw new Error("Cesium gagal dimuat");

  if (tokens.cesiumIonToken) {
    Cesium.Ion.defaultAccessToken = tokens.cesiumIonToken;
  }

  viewer = new Cesium.Viewer(container, {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: true,
    infoBox: false,
    baseLayer: false,
    creditContainer: creditContainer(container.ownerDocument),
    msaaSamples: 4,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });
  viewer.targetFrameRate = 60;

  // Google 3D tiles hanya bila kunci Google tersedia (tidak dibypass).
  let googleTileset = null;
  if (tokens.googleMapsKey && Cesium.createGooglePhotorealistic3DTileset) {
    try {
      Cesium.GoogleMaps.defaultApiKey = tokens.googleMapsKey;
      googleTileset = await Cesium.createGooglePhotorealistic3DTileset();
    } catch (_) {
      googleTileset = null;
    }
  }

  mapStack = new window.MataDewaMapStack.MapStackController(viewer, {
    googleTileset,
    cesiumToken: tokens.cesiumIonToken || "",
  });
  await mapStack.setStack(googleTileset ? "photoreal" : "esri-imagery", { silent: true });
  if (!googleTileset) {
    // Terrain keyless opsional; gagal → elipsoid (tetap usable).
    mapStack.enableKeylessTerrain().catch(() => {});
  }

  // Lapisan entitas untuk observasi/aset/event.
  entityLayer = new Cesium.CustomDataSource("mata-dewa");
  viewer.dataSources.add(entityLayer);

  // Kamera awal: globe view Indonesia (bukan lokasi presisi pengguna).
  flyTo(ESRI_FALLBACK_CAMERA, { duration: 0 });

  // Governor idle hemat daya.
  window.MataDewaRenderGovernor?.installRenderGovernor(viewer);

  return viewer;
}

export function getViewer() { return viewer; }
export function getMapStack() { return mapStack; }
export function getEntityLayer() { return entityLayer; }

/** Terbang ke titik/ketinggian. coords: {lat, lon, alt}. */
export function flyTo({ lat, lon, alt = 2000000 }, { duration = 1.6 } = {}) {
  if (!viewer || !window.Cesium) return false;
  const Cesium = window.Cesium;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
    duration,
  });
  window.MataDewaRenderGovernor?.holdContinuousRender("camera-flight");
  setTimeout(() => window.MataDewaRenderGovernor?.releaseContinuousRender("camera-flight"),
    Math.max(300, duration * 1000 + 200));
  return true;
}

/** Atur basemap stack. */
export async function setStack(id) {
  if (!mapStack) return { ok: false, reason: "globe belum siap" };
  try {
    await mapStack.setStack(id);
    return { ok: true, id };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

const TYPE_COLOR = {
  earthquake: "#FF6B4A",
  flight: "#28AFFF",
  satellite: "#B39CFF",
  vessel: "#3FD0C9",
  weather: "#8AD0FF",
  lightning: "#FFD23F",
  fire: "#FF4A3D",
  asset: "#48E6A5",
  generic: "#9FB3C8",
};

function colorFor(type) {
  const Cesium = window.Cesium;
  const hex = TYPE_COLOR[type] || TYPE_COLOR.generic;
  return Cesium.Color.fromCssColorString(hex);
}

/** Render satu set observasi ke globe (point). Mengembalikan jumlah. */
export function renderObservations(observations = []) {
  if (!viewer || !entityLayer || !window.Cesium) return 0;
  const Cesium = window.Cesium;
  entityLayer.entities.removeAll();
  let count = 0;
  for (const obs of observations) {
    const g = obs.geometry;
    if (g?.type !== "point") continue; // orbit/polygon ditangani renderer khusus
    const id = obs.id || `obs_${count}`;
    entityLayer.entities.add({
      id,
      position: Cesium.Cartesian3.fromDegrees(g.lon, g.lat),
      point: {
        pixelSize: obs.type === "earthquake" ? 9 : 6,
        color: colorFor(obs.type),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.4, 2.2e7, 0.5),
      },
      properties: { observation: obs },
    });
    count++;
  }
  window.MataDewaRenderGovernor?.governorRequestRender();
  return count;
}

/** Pilih entitas (fly-to + seleksi). */
export function selectEntity(id) {
  if (!viewer || !entityLayer) return false;
  const entity = entityLayer.entities.getById(id);
  if (!entity) return false;
  viewer.selectedEntity = entity;
  viewer.flyTo(entity, { duration: 1.2 });
  return true;
}

/** Lacak entitas (kamera mengikuti). */
export function trackEntity(id) {
  if (!viewer || !entityLayer) return { ok: false, reason: "globe belum siap" };
  const entity = entityLayer.entities.getById(id);
  if (!entity) return { ok: false, reason: `entitas tidak ditemukan: ${id}` };
  viewer.trackedEntity = entity;
  trackedEntityId = id;
  window.MataDewaRenderGovernor?.holdContinuousRender("tracked-entity");
  return { ok: true, id };
}

export function stopTracking() {
  if (!viewer) return { ok: false };
  viewer.trackedEntity = undefined;
  trackedEntityId = null;
  window.MataDewaRenderGovernor?.releaseContinuousRender("tracked-entity");
  return { ok: true };
}

export function getTrackedEntityId() { return trackedEntityId; }

/** Bersihkan sumber daya saat view di-unmount (inti headless tetap hidup). */
export function destroyGlobe() {
  stopTracking();
  if (viewer && !viewer.isDestroyed()) {
    try { viewer.destroy(); } catch (_) { /* noop */ }
  }
  viewer = null;
  mapStack = null;
  entityLayer = null;
}
