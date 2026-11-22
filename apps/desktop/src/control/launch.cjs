'use strict';
// Owner launcher for DAMAR Control: reads the Core session's private credentials (the same files the CLI reads:
// credentials.json owner, console-credentials.json console) and opens http://127.0.0.1:<port>/control/ with them in
// the URL fragment, which browsers never send to a server. The page keeps them in memory and strips the fragment.
//   node src/control/launch.cjs <Core session folder> [--print]
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');

function controlUrl(directory) {
  if (!directory || !path.isAbsolute(directory)) throw Error('ABSOLUTE_CORE_SESSION_REQUIRED');
  const read = f => JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8'));
  const owner = read('credentials.json').owner, consoleToken = read('console-credentials.json').console;
  const address = new URL(read('core-host.json').address);
  if (address.hostname !== '127.0.0.1' || address.protocol !== 'http:') throw Error('CORE_NOT_LOOPBACK');
  for (const t of [owner, consoleToken]) if (typeof t !== 'string' || !/^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(t)) throw Error('INVALID_PRIVATE_CREDENTIAL');
  return `http://127.0.0.1:${address.port}/control/#owner=${encodeURIComponent(owner)}&console=${encodeURIComponent(consoleToken)}`;
}

if (require.main === module) {
  try {
    const url = controlUrl(process.argv[2] && path.resolve(process.argv[2]));
    if (process.argv.includes('--print')) console.log(url);
    else { spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); console.log('DAMAR Control opened (credential passed in URL fragment only).'); }
  } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}
module.exports = { controlUrl };
