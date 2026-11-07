/*
 * Adapted from God's Eye View — https://github.com/bilawalsidhu/gods-eye-view
 * MIT License — Copyright (c) 2026 Bilawal Sidhu
 *
 * styles/* (KEEP §3.1, adapted): filter visual post-process. Adaptasi Mata
 * Dewa memakai fragmen GLSL sederhana per gaya (retro/surveillance/thermal/
 * noir/snow/anime dinormalisasi ke satu jahitan post-process Cesium).
 */
(function () {
  "use strict";

  const FRAGMENTS = {
    normal: null,
    retro: `
      uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
      void main(){ vec4 c=texture(colorTexture,v_textureCoordinates);
        float g=dot(c.rgb,vec3(0.299,0.587,0.114));
        out_FragColor=vec4(g*1.2,g*0.95,g*0.4,c.a); }`,
    surveillance: `
      uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
      void main(){ vec4 c=texture(colorTexture,v_textureCoordinates);
        float g=dot(c.rgb,vec3(0.299,0.587,0.114));
        out_FragColor=vec4(0.0,g,0.15,c.a); }`,
    thermal: `
      uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
      void main(){ vec4 c=texture(colorTexture,v_textureCoordinates);
        float g=dot(c.rgb,vec3(0.299,0.587,0.114));
        out_FragColor=vec4(g,0.3*g,1.0-g,c.a); }`,
    noir: `
      uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
      void main(){ vec4 c=texture(colorTexture,v_textureCoordinates);
        float g=dot(c.rgb,vec3(0.299,0.587,0.114));
        out_FragColor=vec4(vec3(g),c.a); }`,
    snow: `
      uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
      void main(){ vec4 c=texture(colorTexture,v_textureCoordinates);
        out_FragColor=vec4(mix(c.rgb,vec3(1.0),0.35),c.a); }`,
    anime: `
      uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
      void main(){ vec4 c=texture(colorTexture,v_textureCoordinates);
        vec3 q=floor(c.rgb*6.0)/6.0; out_FragColor=vec4(q,c.a); }`,
  };

  const STYLES = ["normal", "retro", "surveillance", "thermal", "anime", "noir", "snow"];

  let activeStage = null;
  let activeStyle = "normal";

  function setVisualStyle(viewer, style) {
    const Cesium = window.Cesium;
    if (!viewer || !Cesium) return { ok: false, reason: "globe belum siap" };
    if (!STYLES.includes(style)) return { ok: false, reason: `gaya tidak dikenal: ${style}` };

    if (activeStage) {
      try { viewer.scene.postProcessStages.remove(activeStage); } catch (_) { /* noop */ }
      activeStage = null;
    }
    activeStyle = style;

    if (style === "normal") {
      viewer.scene.requestRender?.();
      return { ok: true, style };
    }
    const fragment = FRAGMENTS[style];
    if (!fragment) return { ok: false, reason: `gaya ${style} belum punya shader` };
    activeStage = viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({ fragmentShader: fragment })
    );
    viewer.scene.requestRender?.();
    return { ok: true, style };
  }

  function getVisualStyle() { return activeStyle; }
  function listStyles() { return STYLES.slice(); }

  window.MataDewaStyles = { setVisualStyle, getVisualStyle, listStyles };
})();
