'use strict';
// A real-runtime smoke check. Never starts Damar canonical server or requests effects.
const fs = require('node:fs');
const path = require('node:path');
const { V3ShadowClient } = require('../../src/integration/cognitiveV3Shadow/V3ShadowClient');

async function main() {
  if (process.argv.length !== 3) throw new Error('USAGE: node run_shadow_smoke.js <local-config.json>');
  const configFile = path.resolve(process.argv[2]);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config || typeof config !== 'object' || typeof config.env !== 'object') {
    throw new Error('INVALID_SHADOW_CONFIG');
  }
  // Only a small set of environment variables is admitted to the child.
  const env = {
    DAMAR_V3_SHADOW_ONLY: '1',
    PYTHONPATH: config.env.PYTHONPATH,
    PATH: config.env.PATH ?? process.env.PATH,
    HOME: config.env.HOME ?? process.env.HOME,
    LANG: 'C.UTF-8'
  };
  const bridge = new V3ShadowClient({
    executable: config.executable,
    args: config.args,
    cwd: config.cwd,
    env,
    timeoutMs: 20000
  });
  try {
    await bridge.start();
    const before = await bridge.snapshot();
    const receipt = await bridge.observe('activity', 1);
    const after = await bridge.snapshot();
    if (after.event_count < before.event_count + 1) throw new Error('EVENT_NOT_PERSISTED');
    process.stdout.write(JSON.stringify({
      status: 'SHADOW_SMOKE_PASS',
      before_event_count: before.event_count,
      after_event_count: after.event_count,
      disposition: receipt.disposition,
      authority: after.authority,
      production: after.production,
      protected_effects: after.protected_effects
    }) + '\n');
  } finally {
    await bridge.close().catch(() => {});
  }
}
main().catch(err => {
  process.stderr.write('SHADOW_SMOKE_FAIL: ' + err.message + '\n');
  process.exitCode = 1;
});
