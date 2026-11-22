'use strict';
const fs = require('node:fs');
const path = require('node:path');
async function main(args) {
  args=args.filter(arg=>arg!=='--json');
  if(args.includes('--version'))return {product:'DAMAR private UIX',contract:'r7r3',execution:'shared Node runtime; Python is a bridge',production:false};
  if(args.includes('--help') || !args.length) return {usage:'<session-directory> status|doctor|jobs|provider|werkudara [status|on|off] [EVENT_ONLY|EVENT_REVIEW] [calls]; job <plan|approve|execute|verify|cancel|revoke> <JSON body or - for UTF-8 stdin> [--json]',authority:'isolated-test',approval:'approve and revoke require explicit --owner flag'};
  const [directory, verb='status', action='status', mode='EVENT_ONLY', calls='1'] = args;
  if (!directory) throw Error('Usage: node scripts/r7r3-cli.cjs <session-directory> status|doctor|jobs|provider|werkudara [status|on|off] [EVENT_ONLY|EVENT_REVIEW] [1..3]');
  const session=JSON.parse(fs.readFileSync(path.join(directory,'session.json'),'utf8'));
  const url=new URL(session.address);
  if (url.hostname!=='127.0.0.1' || url.protocol!=='http:' || url.username || url.password) throw Error('LOOPBACK_SESSION_REQUIRED');
  let route='/api/r7/control', method='GET', body;
   if (['jobs','doctor'].includes(verb)) route='/api/r6/state';
  else if (verb==='werkudara') {
    if (!['status','on','off'].includes(action)) throw Error('UNKNOWN_ACTION');
    route=`/api/r7/supervisor/${action}`;
    if (action!=='status') { if(!args.includes('--owner'))throw Error('EXPLICIT_OWNER_ROLE_REQUIRED');method='POST'; body=action==='off'?{}:{mode,maxCalls:mode==='EVENT_ONLY'?0:Number(calls),maxSpendUnits:mode==='EVENT_ONLY'?0:Number(calls)}; }
  } else if (verb==='job') {
    if(!['plan','approve','execute','verify','cancel','revoke'].includes(action))throw Error('UNKNOWN_JOB_ACTION');
    if(['approve','revoke'].includes(action)&&!args.includes('--owner'))throw Error('EXPLICIT_OWNER_ROLE_REQUIRED');
    route='/api/r6/'+action;method='POST';
    let input=mode;
    if(mode==='-'){
      const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>8192)throw Error('STDIN_BODY_TOO_LARGE');chunks.push(chunk);}
      input=Buffer.concat(chunks).toString('utf8');
    }
    try{body=JSON.parse(input);}catch{throw Error('INVALID_JOB_JSON');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_JOB_JSON');
  } else if (!['status','provider'].includes(verb)) throw Error('UNKNOWN_COMMAND');
  const credentials=JSON.parse(fs.readFileSync(path.join(directory,'credentials.json'),'utf8'));
  const ownerRole=verb==='werkudara'&&method==='POST'||verb==='job'&&['approve','revoke'].includes(action);
  const response=await fetch(new URL(route,url),{method,headers:{authorization:`Bearer ${ownerRole?credentials.owner:credentials.requester}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
  const data=await response.json(); if(!response.ok) throw Error(typeof data.error==='object'?data.error.code:data.error || `HTTP_${response.status}`);
  return verb==='provider'?{available:data.providerAvailable,kind:data.providerKind,liveInference:false}:data;
}
if(require.main===module) main(process.argv.slice(2)).then(data=>console.log(JSON.stringify(data,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
