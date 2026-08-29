/* Damar Voice Widget — dibuat oleh Damar, 2026-08-17
   Mendengarkan feed.json dari server suara Damar (port 8643)
   dan memutar suara aslinya langsung di Console. */
(function () {
  if (window.__damarVoice) return; window.__damarVoice = true;
  var FEED = 'http://127.0.0.1:8643/voice/feed.json';
  var lastTs = 0, playing = false, muted = (localStorage.getItem('damar-voice-mute') === '1');

  var w = document.createElement('div');
  w.id = 'damar-voice-widget';
  w.style.cssText = 'position:fixed;bottom:18px;left:18px;z-index:99999;display:flex;align-items:center;gap:10px;background:rgba(4,12,20,.82);border:1px solid rgba(0,229,255,.35);border-radius:10px;padding:8px 14px;font:12px/1.4 system-ui;color:#9fd8e8;cursor:pointer;backdrop-filter:blur(4px);user-select:none;transition:opacity .3s;opacity:.55';
  w.innerHTML = '<span id="av-eq" style="display:inline-flex;gap:2px;align-items:flex-end;height:12px">' +
    '<i style="width:3px;background:#00e5ff;height:4px;border-radius:1px"></i>' +
    '<i style="width:3px;background:#00e5ff;height:8px;border-radius:1px"></i>' +
    '<i style="width:3px;background:#00e5ff;height:6px;border-radius:1px"></i>' +
    '<i style="width:3px;background:#00e5ff;height:10px;border-radius:1px"></i></span>' +
    '<span id="av-label">\u266A Damar</span>';
  document.body.appendChild(w);
  var label = w.querySelector('#av-label'), eq = w.querySelector('#av-eq');

  w.addEventListener('click', function () {
    muted = !muted;
    localStorage.setItem('damar-voice-mute', muted ? '1' : '0');
    label.textContent = muted ? '\u266A Damar (bisu)' : '\u266A Damar';
  });

  function animate(on) {
    w.style.opacity = on ? 1 : .55;
    eq.querySelectorAll('i').forEach(function (b, i) {
      b.style.animation = on ? 'avBounce .9s ease-in-out ' + (i * .13) + 's infinite' : 'none';
    });
    w.style.borderColor = on ? 'rgba(0,229,255,.9)' : 'rgba(0,229,255,.35)';
  }
  var st = document.createElement('style');
  st.textContent = '@keyframes avBounce{0%,100%{height:4px}50%{height:12px}}';
  document.head.appendChild(st);

  function tick() {
    fetch(FEED + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.url || d.ts === lastTs) return;
      lastTs = d.ts;
      if (muted) return;
      var a = new Audio(d.url);
      playing = true; animate(true);
      a.onended = a.onerror = function () { playing = false; animate(false); };
      a.play().catch(function () { playing = false; animate(false); });
    }).catch(function () {});
  }
  setInterval(tick, 2000); tick();
  window.damarVoiceSay = function (t) { label.textContent = t || '\u266A Damar'; };
})();
