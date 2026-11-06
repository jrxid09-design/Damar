'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {V3ShadowClient} = require('../../../src/integration/cognitiveV3Shadow/V3ShadowClient');
const fixture = path.join(__dirname, 'fake_sidecar.js');
function client(unsafe=false,unsafeResult=false) { return new V3ShadowClient({
  executable:process.execPath, args:[fixture,...(unsafe?['--unsafe']:[]),...(unsafeResult?['--unsafe-result']:[])],
  cwd:__dirname,env:{...process.env,DAMAR_V3_SHADOW_ONLY:'1'}
}); }
test('must explicitly enable shadow gate',()=>{
  assert.throws(()=>new V3ShadowClient({executable:'node',args:[],cwd:'.',env:{}}),/SHADOW_CONFIGURATION_REQUIRED/);
});
test('snapshot, synthetic observation and graceful shutdown',async()=>{
  const c=await client().start();
  const state=await c.snapshot();
  assert.equal(state.authority,'NONE');
  const r=await c.observe('activity',1);
  assert.equal(r.disposition,'COMMITTED');
  await c.close();
  await assert.rejects(c.snapshot(),/SHADOW_NOT_READY/);
});
test('reject any handshake that claims privileged authority',async()=>{
  const c=client(true);
  await assert.rejects(c.start(),/UNSAFE_RUNTIME_STATE/);
  assert.equal(c.closed,true);
});
test('reject oversized request before IPC write',async()=>{
  const c=await client().start();
  await assert.rejects(c.request('observe',{category:'activity',count:1,extra:'x'.repeat(20000)}),/REQUEST_TOO_LARGE/);
  await c.close();
});

test('reject forged privileged snapshot even with safe root metadata',async()=>{
  const c=await client(false,true).start();
  await assert.rejects(c.snapshot(),/UNSAFE_RESPONSE/);
  assert.equal(c.closed,true);
});
test('reject unsupported operations before they reach child process',async()=>{
  const c=await client().start();
  await assert.rejects(c.request('execute',{tool:'shell'}),/UNKNOWN_OPERATION/);
  await c.close();
});
