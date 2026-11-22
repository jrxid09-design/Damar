'use strict';
const {contracts}=require('./core-catalog.cjs');
function createHud(){return {
 viewState:'INTRO',
 runtime:{state:'NOT_QUERIED'},jobs:{state:'NOT_QUERIED',plans:null,jobs:null},
  catalogs:{mcp:{state:'NOT_QUERIED'},plugins:{state:'NOT_QUERIED'},tools:{state:'NOT_QUERIED'},skills:{state:'UNAVAILABLE',reason:'NO_ESTABLISHED_CORE_SKILLS_HTTP_CONTRACT'}},
 operation:{state:'NOT_QUERIED'},subagents:{state:'NOT_QUERIED'},diff:{state:'NO_VERIFIED_DIFF'},
  authority:'Core readback only; no parallel registry',catalogRoutes:{mcp:contracts.mcp.route,plugins:contracts.plugins.route,tools:contracts.tools.route,skills:null}
};}
const safeStatus=value=>typeof value==='string'&&/^[A-Z0-9_ -]{1,64}$/i.test(value)?value.toUpperCase():'UNKNOWN';
const safeCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=100000?value:null;
function updateHud(hud,command,result){
 if(!hud||!result||typeof result!=='object')return hud;
 if(command==='status'){
  hud.runtime={state:result.connection==='online'?'ONLINE':'UNAVAILABLE',provider:typeof result.provider==='string'?safeStatus(result.provider):'UNAVAILABLE',supervisor:result.supervisor==='ON'?'ON':result.supervisor==='OFF'?'OFF':'UNKNOWN'};
 }else if(command==='jobs'){
  const jobs=Array.isArray(result.jobs)?result.jobs:[],plans=Array.isArray(result.plans)?result.plans:[];
  hud.jobs={state:'READ_ONLY',plans:safeCount(plans.length),jobs:safeCount(jobs.length),latest:plans.slice(-3).map(row=>({id:typeof row.planId==='string'?row.planId.slice(0,12):'UNAVAILABLE',status:safeStatus(row.status||'UNKNOWN'),version:safeCount(row.version)}))};
  }else if(['mcp','plugins','tools','skills'].includes(command)){
  const namespace=command;
  if(result.state==='UNAVAILABLE')hud.catalogs[namespace]={state:'UNAVAILABLE',reason:safeStatus(result.reason||'CORE_CATALOG_UNAVAILABLE')};
  else if(result.state==='READ_ONLY'&&result.namespace===namespace){
   if(namespace==='mcp')hud.catalogs.mcp={state:'READ_ONLY',servers:safeCount(result.data?.servers?.length),running:safeCount(result.data?.clients?.running),bridged:safeCount(result.data?.clients?.bridged)};
    else if(namespace==='plugins')hud.catalogs.plugins={state:'READ_ONLY',plugins:safeCount(result.data?.total)};
    else if(namespace==='tools')hud.catalogs.tools={state:'READ_ONLY',tools:safeCount(result.data?.total),shown:safeCount(result.data?.tools?.length),truncated:result.data?.truncated===true};
   }
 }else if(command==='agents'){
  if(result.state==='UNAVAILABLE')hud.subagents={state:'UNAVAILABLE',reason:safeStatus(result.reason||'CORE_AGENTS_READ_UNAVAILABLE')};
  else if(result.state==='READ_ONLY'&&result.namespace==='agents'){
   const rows=Array.isArray(result.data?.agents)?result.data.agents:[];
   const online=rows.filter(row=>row?.state==='ONLINE').length;
   hud.subagents={state:'READ_ONLY',total:safeCount(rows.length),online:safeCount(online),agents:rows.slice(0,8).map(row=>({id:row.id,label:typeof row.label==='string'?row.label.slice(0,48):'Pandawa',state:safeStatus(row.state)}))};
  }
 }else if(['provider','connect','model'].includes(command)&&(result.state==='SELECTED'||result.state==='READ_ONLY'&&result.namespace==='provider')){
  const id=result.provider||result.active,model=result.model;
  if(typeof id==='string'&&typeof model==='string')hud.provider={id:id.slice(0,32),model:model.slice(0,64),executable:result.executable===true};
 }else if(command==='subagent'){
  // Only Core readback populates runs; no timer or local guess ever changes a run state.
  const rows=Array.isArray(result.runs)?result.runs:result.run?[result.run]:[];
  const map=new Map((hud.subagentRuns||[]).map(r=>[r.runId,r]));
  for(const r of rows)if(r&&typeof r.runId==='string')map.set(r.runId,{runId:r.runId,worker:typeof r.worker==='string'?r.worker.slice(0,16):'?',state:safeStatus(r.state),cancelRequested:r.cancelRequested===true});
  hud.subagentRuns=[...map.values()].slice(-8);
 }else if(['plan','revise','approve','execute','verify','revoke','cancel','reconcile'].includes(command)){
  const data=result.data||{};
  hud.operation={state:safeStatus(result.state||'UNKNOWN'),action:command,
   planId:typeof data.planId==='string'?data.planId.slice(0,16):null,
   version:safeCount(data.version),observedStatus:typeof result.observedStatus==='string'?safeStatus(result.observedStatus):null};
 }
 return hud;
}
function projection(hud){
 return {viewState:hud.viewState,runtime:hud.runtime,jobs:hud.jobs,catalogs:hud.catalogs,operation:hud.operation,
  subagents:hud.subagents,subagentRuns:hud.subagentRuns||[],provider:hud.provider||null,diff:hud.diff,authority:hud.authority};
}
// W5 transcript layout for a command result: same data, labelled rows instead of a JSON dump. Plain header
// ("<command> · <STATE>"), no decorative symbols or branding.
// Null/undefined fields are omitted; everything else is shown verbatim.
function formatResult(result,title){
 if(!result||typeof result!=='object')return String(result);
 const {state,namespace,...rest}=result,out=[(namespace||title)+(state?' · '+state:'')];
 const walk=(obj,indent)=>{const keys=Object.keys(obj).filter(k=>obj[k]!=null),width=Math.max(0,...keys.map(k=>k.length));
  for(const k of keys){const v=obj[k];
   if(Array.isArray(v)){if(!v.length||v.every(x=>x===null||typeof x!=='object'))out.push(indent+k.padEnd(width)+'  '+(v.length?v.join(', '):'(none)'));else v.forEach((x,i)=>{out.push(indent+k+' '+(i+1)+'/'+v.length);walk(x,indent+'  ');});}
   else if(typeof v==='object'){out.push(indent+k);walk(v,indent+'  ');}
   else out.push(indent+k.padEnd(width)+'  '+String(v));}};
 walk(rest,'  ');return out.join('\n');
}
module.exports={createHud,updateHud,projection,formatResult};
