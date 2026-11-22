'use strict';
// Private stdin transport of the Windows service host, never a network listener.
const { openAdmission } = require('./protected-admission.cjs');
const fs = require('node:fs');
async function run() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const engine = openAdmission({ directory: config.directory, scopeId: config.scopeId });
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8192) throw Error('AUTHORITY_MESSAGE_TOO_LARGE'); }
  const request = JSON.parse(input);
  if (request.scopeId !== config.scopeId) throw Error('AUTHORITY_SCOPE_MISMATCH');
  let data;
  if (request.operation === 'status') data = engine.status();
  else if (request.operation === 'revoke') data = engine.revoke(request.revision);
  else if (request.operation === 'advance') data = engine.advance(request.revision, request.digest, request.expiresAt);
  else throw Error('AUTHORITY_PROVIDER_CONTRACT_UNAVAILABLE');
  // No reserve/settle/dispatch API until the service can enforce provider bounds
  // and receive authoritative receipts without taking credentials from Core.
  process.stdout.write(JSON.stringify({ success: true, data }));
}
run().catch(error => { process.stdout.write(JSON.stringify({ success: false, error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AUTHORITY_FAILED' })); process.exitCode = 1; });
