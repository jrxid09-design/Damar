/*
 * cesiumLoader.js — pemuat Cesium IIFE tervendor (lazy, sekali saja).
 *
 * Memuat vendor/cesium/cesium.bundle.js + widgets.css, mengatur
 * CESIUM_BASE_URL ke aset statik tervendor, lalu mengekspos window.Cesium.
 * Kegagalan memuat dilaporkan jujur (globe degraded), tidak melempar ke boot.
 */

let loadingPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error(`gagal memuat ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

/** Muat Cesium (idempoten). Mengembalikan window.Cesium atau null. */
export async function loadCesium() {
  if (window.Cesium) return window.Cesium;
  if (loadingPromise) return loadingPromise;

  const base = "../../vendor/cesium/";
  window.CESIUM_BASE_URL = base;
  loadCss(base + "widgets.css");

  loadingPromise = loadScript(base + "cesium.bundle.js")
    .then(() => {
      if (!window.Cesium) throw new Error("Cesium global tidak ditemukan");
      return window.Cesium;
    })
    .catch((error) => {
      console.warn("[MataDewa] Cesium gagal dimuat:", error.message);
      loadingPromise = null;
      return null;
    });

  return loadingPromise;
}
