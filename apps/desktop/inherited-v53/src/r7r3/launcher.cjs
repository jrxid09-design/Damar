'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createR7Composition } = require('../r7/composition');
const { createSurfaces } = require('../r6/productSurfaces');
const { install } = require('./outputGuard.cjs');
const endpoint = require('./endpoint.cjs');

async function start({ directory, port = 0, resume = false, recovered = false, mockReview = false, root = path.resolve(__dirname, '../..'), scratchRoot = process.env.DAMAR_DATA_ROOT } = {}) {
  if (!directory || !path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) throw Error('EXPLICIT_RUN_DIRECTORY_REQUIRED');
  if (!scratchRoot || !path.isAbsolute(scratchRoot)) throw Error('R7R3_SCRATCH_ROOT_REQUIRED');
  const scratch = path.resolve(scratchRoot);
  const target = path.resolve(directory);
  if (!target.toLowerCase().startsWith(scratch.toLowerCase() + path.sep)) throw Error('R7R3_RUN_OUTSIDE_SCRATCH');
  const check = install(scratch); check(target);
  if(resume||recovered){
    if(!fs.existsSync(path.join(target,recovered?'RECOVERY_READY.json':'FINISHED.json')))throw Error('EXPLICIT_SESSION_MARKER_REQUIRED');
  }else{
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target,'STARTED.json'), JSON.stringify({pid:process.pid}), {flag:'wx'});
  }
  const credentials = resume||recovered?JSON.parse(fs.readFileSync(path.join(target,'credentials.json'),'utf8')):{ owner: crypto.randomBytes(32).toString('hex'), requester: crypto.randomBytes(32).toString('hex') };
  if(!resume&&!recovered)fs.writeFileSync(path.join(target,'credentials.json'), JSON.stringify(credentials), {flag:'wx', mode:0o600});
  const surfaces = createSurfaces(root);
  // Nonsecret incarnation identity distinguishes a restarted authority from stale UI readback.
  const runtimeInstanceId=crypto.randomUUID();
  let mockCalls=0;
  const provider=mockReview?{mocked:true,async review(payload){
    mockCalls++;
    return JSON.stringify({eventId:payload.eventId,reasonCode:payload.reasonCode,recommendation:'observe',metrics:payload.metrics});
  }}:undefined;
  const composed = createR7Composition({ statePath:path.join(target,'jobs.json'), supervisorPath:path.join(target,'supervisor'), credentials, provider,
    async staticHandler(req,res) {
      const controlFiles={'/cc2':['control-v2.html','text/html'],'/uix/control-v2.js':['control-v2.js','text/javascript'],'/uix/control.js':['control.js','text/javascript'],'/uix/control.css':['control.css','text/css'],'/__preview-adapters/idle-presence.js':['presence.js','text/javascript'],'/__preview-adapters/mobile.js':['mobile.js','text/javascript']};
      const pathname=new URL(req.url,'http://127.0.0.1').pathname;
      if(req.method==='POST' && /^\/api\/r7r3\/jobs\/(plan|approve|execute|verify|cancel|revoke|reconcile)$/.test(pathname)){
        let bytes=0;const chunks=[];
        for await(const chunk of req){bytes+=chunk.length;if(bytes>8192){res.writeHead(413);res.end();return true;}chunks.push(chunk);}
        const action=pathname.split('/').pop();
        const response=await fetch(`http://127.0.0.1:${req.socket.localPort}/api/r6/${action==='reconcile'?'state':action}`,{method:action==='reconcile'?'GET':'POST',headers:{authorization:req.headers.authorization||'','content-type':req.headers['content-type']||''},body:action==='reconcile'?undefined:Buffer.concat(chunks),signal:AbortSignal.timeout(4000)});
        res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});res.end(await response.text());return true;
      }
      if(req.method==='GET' && pathname==='/api/r7r3/models'){
        let value;
        try{if(!endpoint.gateway)throw Object.assign(Error('No built-in provider; use /api/r9/models for your own connections'),{name:'NotConfigured'});const response=await fetch(endpoint.gateway+'/models',{signal:AbortSignal.timeout(2500),redirect:'error'});
          if(!response.ok)throw Error(response.status===401||response.status===403?'Gateway requires approved credentials':`Gateway HTTP ${response.status}`);
          const body=await response.json();if(!Array.isArray(body.data))throw Error('Unsupported catalog response');
          const models=[...new Set(body.data.slice(0,512).filter(row=>row&&typeof row.id==='string'&&row.id===row.id.trim()&&row.id.length>0&&row.id.length<=256&&!/[\x00-\x1f\x7f]/.test(row.id)).map(row=>row.id))].map(id=>({id}));
          value={available:true,state:models.length?'AVAILABLE':'EMPTY',models,inference:false};
        }catch(error){value={available:false,state:error.message==='Gateway requires approved credentials'?'AUTHENTICATION_REQUIRED':error.name==='TimeoutError'?'TIMEOUT':error.name==='NotConfigured'?'NOT_CONFIGURED':'UNAVAILABLE',models:[],reason:error.name==='TimeoutError'?'Gateway metadata lookup exceeded 2500 ms':error.message,inference:false};}
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));return true;
      }
      if(req.method==='GET' && controlFiles[pathname]) {
        const [file,type]=controlFiles[pathname];
        const contents=fs.readFileSync(path.join(root,'src/r7r3',file));
        const inline=file==='control-v2.html'?[...contents.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+crypto.createHash('sha256').update(m[1]).digest('base64')+"'").join(' '):'';
        res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; img-src 'self' data:; script-src 'self' "+inline+"; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'"});
        res.end(contents);return true;
      }
      if (req.method === 'GET' && req.url === '/api/r7r3/overview') {
        const state = composed.service.snapshot();
        // A read-only projection intentionally excludes approval IDs and credentials.
        const data = { connection:'online', authority:'isolated-test',
          runtimeInstanceId, jobs:state.jobs, pendingPlans:state.plans.filter(row=>row.status==='PLANNED'),
          failures:state.plans.filter(row=>['FAILED','CANCELLED'].includes(row.status)),
          events:state.events.slice(-32), supervisor:composed.status(),
          provider:{available:mockReview,kind:mockReview?'MOCKED':'unavailable',mockCalls,reason:mockReview?'MOCKED local advisory provider; zero live inference':'No provider configured; no live inference'},
          deviceBridge:{available:false,reason:'No device connected'} };
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify(data)); return true;
      }
      if (req.method === 'GET' && req.url === '/__r6/control.js') {
        res.writeHead(200,{'content-type':'text/javascript'}); res.end(fs.readFileSync(path.join(root,'scripts/preview-adapters/r7-control.js'))); return true;
      }
      return surfaces(req,res);
    } });
  try {
    await new Promise((resolve,reject) => { composed.server.once('error',reject); composed.server.listen(port,'127.0.0.1',resolve); });
  } catch (error) { composed.close(); throw error; }
  const address = `http://127.0.0.1:${composed.server.address().port}`;
  if(resume)fs.unlinkSync(path.join(target,'FINISHED.json'));
  if(recovered)fs.unlinkSync(path.join(target,'RECOVERY_READY.json'));
  fs.writeFileSync(path.join(target,'session.json'),JSON.stringify({address,pid:process.pid,authority:'isolated-test',provider:mockReview?'MOCKED':'unavailable',supervisor:'OFF'}),{flag:resume?'w':'wx'});
  let stopping;
  const stop = () => stopping ||= new Promise(resolve => {
    composed.server.close(() => { fs.writeFileSync(path.join(target,'FINISHED.json'),'{}',{flag:'wx'}); resolve(); });
    composed.server.closeIdleConnections();
    const timer=setTimeout(()=>composed.server.closeAllConnections(),2000); timer.unref();
  });
  return { ...composed, address, directory:target, credentials, stop, mockCalls:()=>mockCalls };
}
if (require.main === module) {
  if (process.env.NODE_OPTIONS || process.env.DAMAR_R7_STATE || process.env.DAMAR_R7_SUPERVISOR_STATE) throw Error('INHERITED_WRITER_ENV_REFUSED');
  start({directory:process.argv[2],port:Number(process.env.DAMAR_UIX_PORT||0),resume:process.argv.includes('--resume'),recovered:process.argv.includes('--recovered'),mockReview:process.argv.includes('--mock-review')}).then(runtime => {
    console.log(JSON.stringify({status:'READY',address:runtime.address,directory:runtime.directory,provider:'unavailable',supervisor:'OFF'}));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>runtime.stop());
    process.on('message',message=>{if(message?.type==='R7R3_STOP') runtime.stop().then(()=>{if(process.connected) process.disconnect();});});
  }).catch(error=>{console.error(error.code || error.message);process.exitCode=1;});
}
module.exports={start};
