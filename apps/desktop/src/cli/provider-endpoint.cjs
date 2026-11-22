'use strict';
// Two spellings of the same endpoint (localhost vs 127.0.0.1) count as unchanged, so an Apply does not resend the URL.
function sameEndpoint(_provider, left, right) {
  if (left === right) return true;
  try {
    const a = new URL(left), b = new URL(right);
    const host = u => ['localhost', '127.0.0.1'].includes(u.hostname) ? '127.0.0.1' : u.hostname;
    return !a.username && !b.username && !a.password && !b.password &&
      a.protocol === b.protocol && host(a) === host(b) && a.port === b.port &&
      a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
  } catch { return false; }
}
module.exports = { sameEndpoint };
