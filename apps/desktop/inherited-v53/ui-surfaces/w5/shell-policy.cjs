'use strict';

function allowedNavigation(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password &&
      ['/s/idle_presence', '/cc2', '/mobile'].includes(url.pathname);
  } catch { return false; }
}

function displayBounds(bounds) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k])) ||
      bounds.width < 1 || bounds.height < 1) throw new TypeError('DISPLAY_BOUNDS_INVALID');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.round(bounds[k])]));
}

function crashBudget({ now = Date.now, max = 2, windowMs = 60000 } = {}) {
  const crashes = [];
  return reason => {
    if (reason === 'clean-exit') return false;
    const time = now();
    while (crashes.length && time - crashes[0] >= windowMs) crashes.shift();
    if (crashes.length >= max) return false;
    crashes.push(time);
    return true;
  };
}

module.exports = { allowedNavigation, displayBounds, crashBudget };
