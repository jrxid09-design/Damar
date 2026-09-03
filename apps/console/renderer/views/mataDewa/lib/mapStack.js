/*
 * Adapted from God's Eye View — https://github.com/bilawalsidhu/gods-eye-view
 * MIT License — Copyright (c) 2026 Bilawal Sidhu
 *
 * mapStackController.js (KEEP §3.1, adapted): 5-stack basemap switcher.
 * Adaptasi untuk Mata Dewa (Damar): Cesium global IIFE (bukan ESM import),
 * stack keyless (Esri/OSM) sebagai default, photoreal/Bing hanya bila token
 * ion/Google tersedia dari Damar (tidak pernah dibypass). Pergantian stack
 * dijaga generasi (anti-race) seperti versi upstream.
 */
(function () {
  "use strict";

  const ESRI_WORLD_IMAGERY_URL =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
  const ESRI_ATTRIBUTION_HTML =
    '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';
  const DEFAULT_OSM_CREDIT = "© OpenStreetMap contributors";
  const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

  const MAP_STACKS = [
    { id: "photoreal", label: "Google 3D", shortLabel: "3D", kind: "photoreal", requiresIon: false },
    { id: "bing-aerial", label: "Bing Aerial", shortLabel: "Aerial", kind: "ion", requiresIon: true },
    { id: "bing-labels", label: "Bing Labels", shortLabel: "Labels", kind: "ion", requiresIon: true },
    { id: "esri-imagery", label: "Esri Satellite", shortLabel: "SAT", kind: "esri-imagery", requiresIon: false },
    { id: "osm", label: "OSM", shortLabel: "OSM", kind: "osm", requiresIon: false },
  ];

  class MapStackController {
    constructor(viewer, { googleTileset = null, cesiumToken = "", initialStack = null, onChange = null, onError = null } = {}) {
      this.viewer = viewer;
      this.googleTileset = googleTileset;
      this.cesiumToken = String(cesiumToken || "").trim();
      this._onChange = onChange;
      this._onError = onError;
      this._imageryLayer = null;
      this._reearthTerrainProvider = null;
      this._switchGen = 0;
      this._activeId = googleTileset ? (initialStack || "photoreal") : "esri-imagery";
      if (!this.isStackAvailable(this._activeId)) {
        this._activeId = googleTileset ? "photoreal" : "esri-imagery";
      }
    }

    getStack(id) { return MAP_STACKS.find((s) => s.id === id) || null; }

    isStackAvailable(id) {
      const stack = this.getStack(id);
      if (!stack) return false;
      if (stack.kind === "photoreal") return !!this.googleTileset;
      if (stack.requiresIon) return !!this.cesiumToken;
      return true; // esri-imagery + osm keyless selalu tersedia
    }

    getStacks() {
      return MAP_STACKS.map((stack) => ({
        ...stack,
        available: this.isStackAvailable(stack.id),
        active: stack.id === this._activeId,
      }));
    }

    get activeId() { return this._activeId; }

    async setStack(id, { silent = false } = {}) {
      const stack = this.getStack(id);
      if (!stack) throw new Error(`stack tidak dikenal: ${id}`);
      if (!this.isStackAvailable(id)) {
        const reason = stack.kind === "photoreal" ? "Google 3D tileset tidak tersedia"
          : stack.requiresIon ? "Cesium ion token belum terpasang"
          : "tidak tersedia";
        throw new Error(reason);
      }
      const Cesium = window.Cesium;
      const gen = ++this._switchGen;
      const commit = (fn) => { if (gen === this._switchGen) fn(); };

      try {
        if (stack.kind === "photoreal" && this.googleTileset) {
          commit(() => {
            this.viewer.scene.globe.show = false;
            if (!this.viewer.scene.primitives.contains(this.googleTileset)) {
              this.viewer.scene.primitives.add(this.googleTileset);
            }
            this._clearImagery();
            this._activeId = id;
          });
        } else {
          let provider;
          if (stack.kind === "ion") {
            provider = await Cesium.IonImageryProvider.fromAssetId(
              stack.id === "bing-labels"
                ? Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
                : Cesium.IonWorldImageryStyle.AERIAL
            );
          } else if (stack.kind === "esri-imagery") {
            provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY_URL);
          } else {
            provider = new Cesium.OpenStreetMapImageryProvider({
              url: "https://tile.openstreetmap.org/",
              credit: DEFAULT_OSM_CREDIT,
            });
          }
          commit(() => {
            if (this.googleTileset && this.viewer.scene.primitives.contains(this.googleTileset)) {
              this.viewer.scene.primitives.remove(this.googleTileset);
            }
            this.viewer.scene.globe.show = true;
            this._setImagery(provider, stack);
            this._activeId = id;
          });
        }
        if (!silent && this._onChange) this._onChange({ id, state: "ready" });
        return id;
      } catch (error) {
        if (this._onError) this._onError(error.message || String(error));
        throw error;
      }
    }

    _setImagery(provider, stack) {
      this._clearImagery();
      this._imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider);
      if (stack.kind === "esri-imagery" && this.viewer.creditDisplay) {
        this.viewer.creditDisplay.addStaticCredit(Cesium.Credit.fromHtml(ESRI_ATTRIBUTION_HTML));
      }
    }

    _clearImagery() {
      if (this._imageryLayer) {
        try { this.viewer.imageryLayers.remove(this._imageryLayer, true); } catch (_) { /* noop */ }
        this._imageryLayer = null;
      }
    }

    /** Keyless terrain (Re:Earth/Mapterhorn) — opsional, gagal → elipsoid. */
    async enableKeylessTerrain() {
      const Cesium = window.Cesium;
      if (!this._reearthTerrainProvider) {
        try {
          this._reearthTerrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
        } catch (_) {
          this._reearthTerrainProvider = null;
          return false;
        }
      }
      this.viewer.terrainProvider = this._reearthTerrainProvider;
      return true;
    }
  }

  window.MataDewaMapStack = { MapStackController, MAP_STACKS };
})();
