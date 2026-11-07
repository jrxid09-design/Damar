/*
 * Adapted from God's Eye View — https://github.com/bilawalsidhu/gods-eye-view
 * MIT License — Copyright (c) 2026 Bilawal Sidhu
 *
 * renderGovernor.js (KEEP §3.1, adapted): idle render-loop governor.
 * Membalik scene ke requestRenderMode saat tidak ada yang beranimasi, dan
 * kembali ke loop kontinu saat ada hold. Penting pada CPU/iGPU (baseline
 * perangkat pengguna). Ref-counted holds; perilaku kontinu identik saat ada
 * animator per-frame.
 */
(function () {
  "use strict";

  const holds = new Set();
  let viewerRef = null;
  let installed = false;

  function apply() {
    if (!viewerRef) return;
    const scene = viewerRef.scene;
    // requestRenderMode = true saat TIDAK ada hold (idle), false saat ada.
    const idle = holds.size === 0;
    scene.requestRenderMode = idle;
    if (!idle) {
      // Pastikan frame segera digambar saat kembali kontinu.
      viewerRef.scene.requestRender?.();
    }
  }

  function installRenderGovernor(viewer) {
    viewerRef = viewer;
    if (installed) { apply(); return; }
    installed = true;
    // Mulai idle: tidak ada animator saat boot.
    viewer.scene.requestRenderMode = true;
    viewer.scene.maximumRenderTimeChange = Infinity;
    apply();
  }

  function holdContinuousRender(reason = "hold") {
    holds.add(reason);
    if (viewerRef) {
      viewerRef.scene.requestRenderMode = false;
      viewerRef.scene.requestRender?.();
    }
    return reason;
  }

  function releaseContinuousRender(reason = "hold") {
    holds.delete(reason);
    apply();
  }

  function governorRequestRender() {
    viewerRef?.scene?.requestRender?.();
  }

  function isHolding() { return holds.size > 0; }
  function holdCount() { return holds.size; }

  window.MataDewaRenderGovernor = {
    installRenderGovernor,
    holdContinuousRender,
    releaseContinuousRender,
    governorRequestRender,
    isHolding,
    holdCount,
  };
})();
