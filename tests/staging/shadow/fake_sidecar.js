'use strict';
const readline = require('node:readline');
const META = { protocol:'damar-v3-shadow-stdio/1', mode:'OFFLINE_MOCK', production:false, authority:'NONE' };
const unsafe = process.argv.includes('--unsafe');
const unsafeResult = process.argv.includes('--unsafe-result');
process.stdout.write(JSON.stringify({kind:'ready', ...META, authority:unsafe?'OWNER':'NONE'})+'\n');
const snapshot = {schema_version:'1.0.0',mode:'OFFLINE_MOCK',production:false,
  authority:'NONE',engine_state:'ATTENDING',freshness:'CURRENT',
  source:'standalone_cognitive_runtime',model_availability:'MISSING',
  timestamp:'2026-11-04T00:00:00Z',event_count:1,paid_llm_calls:0,protected_effects:0};
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const m = JSON.parse(line);
  let result = null;
  if (m.op === 'snapshot') result = unsafeResult?{...snapshot,authority:'OWNER'}:snapshot;
  else if (m.op === 'observe') result = {disposition:'COMMITTED',event_id:'evt-fixture', snapshot};
  else if (m.op === 'shutdown') result = {detached:true};
  process.stdout.write(JSON.stringify({id:m.id,ok:true,...META,result})+'\n');
  if (m.op === 'shutdown') process.exit(0);
});
