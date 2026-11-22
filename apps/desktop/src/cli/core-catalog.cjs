'use strict';
// HTTP projections only. Instances, configuration, credentials and execution stay in Core.
const contracts=Object.freeze({
 mcp:Object.freeze({route:'/api/v1/console/mcp/servers',operation:'list'}),
 plugins:Object.freeze({route:'/api/v1/console/plugins',operation:'list'}),
 tools:Object.freeze({route:'/api/v1/console/tools',operation:'list'}),
 agents:Object.freeze({route:'/api/v1/console/agents',operation:'list'}),
 skills:Object.freeze({route:null,operation:'list'}),
 safety:Object.freeze({route:'/api/v1/console/safety',operation:'status'}),
 memory:Object.freeze({route:'/api/v1/console/memory/stats',operation:'stats'}),
 context:Object.freeze({route:'/api/v1/console/context',operation:'status'}),
});
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:@/-]{1,128}$/.test(value);
const safeVersion=value=>typeof value==='string'&&/^[A-Za-z0-9_.+-]{1,128}$/.test(value);
const safeLabel=value=>typeof value==='string'&&value.trim().length>0&&value.length<=80&&!/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
function project(namespace,body){
 if(body?.success!==true||!body.data||typeof body.data!=='object')throw Error('UNRECOGNIZED_CORE_CATALOG');
 if(namespace==='plugins'){
  const {plugins,total}=body.data;
  if(!Array.isArray(plugins)||plugins.length>1024||!count(total)||total!==plugins.length)throw Error('UNRECOGNIZED_CORE_CATALOG');
  return {total,plugins:plugins.map(row=>{
   if(!safeId(row?.id)||!safeVersion(row.version)||!count(row.toolCount))throw Error('UNRECOGNIZED_CORE_CATALOG');
   return {id:row.id,version:row.version,toolCount:row.toolCount};
  })};
 }
 if(namespace==='tools'){
  const {tools,total}=body.data;
  if(!Array.isArray(tools)||tools.length>4096||!count(total)||total!==tools.length)throw Error('UNRECOGNIZED_CORE_CATALOG');
  const seen=new Set();
  const safeTools=tools.map(row=>{
   if(!safeId(row?.id)||(row.pluginId!==null&&row.pluginId!==undefined&&!safeId(row.pluginId))||seen.has(row.id))throw Error('UNRECOGNIZED_CORE_CATALOG');
   seen.add(row.id);return {id:row.id,pluginId:row.pluginId??null};
  });
  return {total,tools:safeTools.slice(0,64),truncated:safeTools.length>64};
 }
 if(namespace==='agents'){
  const {agents}=body.data;
  if(!Array.isArray(agents)||agents.length>128)throw Error('UNRECOGNIZED_CORE_CATALOG');
  const pandawa=agents.filter(row=>typeof row?.entityId==='string'&&row.entityId.startsWith('pandawa:'));
  return {agents:pandawa.map(row=>{
    if(!/^pandawa:[a-z][a-z0-9_-]{0,63}$/.test(row.entityId)||typeof row.id!=='string'||!safeId(row.id)||
       !safeLabel(row.label)||typeof row.online!=='boolean')throw Error('UNRECOGNIZED_CORE_CATALOG');
   return {id:row.id,entityId:row.entityId,label:row.label.trim(),state:row.online?'ONLINE':'OFFLINE'};
  })};
 }
 if(namespace==='mcp'){
  const {servers,clients,server}=body.data;
  if(!Array.isArray(servers)||servers.length>1024||!count(clients?.running)||!count(clients?.bridged)||!count(server?.exposed)||!count(server?.total)||server.exposed>server.total||typeof server.destructiveHidden!=='boolean')throw Error('UNRECOGNIZED_CORE_CATALOG');
  return {server:{exposed:server.exposed,total:server.total,destructiveHidden:server.destructiveHidden},clients:{running:clients.running,bridged:clients.bridged},servers:servers.map(row=>{
   if(!safeId(row?.id)||typeof row.online!=='boolean'||!count(row.tools))throw Error('UNRECOGNIZED_CORE_CATALOG');
   return {id:row.id,online:row.online,tools:row.tools};
  })};
 }
 // Counts and states only: host names, database paths, URLs and personal rows are never projected.
 if(namespace==='safety'){
  const d=body.data;if(typeof d.stopped!=='boolean'||typeof d.engaged!=='boolean'||!count(d.risk?.total)||!count(d.risk?.destructive)||!count(d.risk?.safe))throw Error('UNRECOGNIZED_CORE_CATALOG');
  return {killSwitch:d.stopped?'STOPPED':'RUNNING',engaged:d.engaged,enforcement:d.policy?.enforcement?.enabled===true?'ENABLED':'DISABLED',standingAuthorizations:Object.keys(d.policy?.authorizations||{}).length,toolRisk:{total:d.risk.total,destructive:d.risk.destructive,safe:d.risk.safe},cliApprovalPolicy:'default Deny; each mutation needs separate Owner confirmation; no session-wide grant'};
 }
 if(namespace==='memory'){
  const d=body.data;if(!count(d.memories?.total)||!count(d.entities?.total)||!count(d.documents?.total))throw Error('UNRECOGNIZED_CORE_CATALOG');
  return {memories:d.memories.total,pinned:count(d.memories.pinned)?d.memories.pinned:null,sensitive:count(d.memories.sensitive)?d.memories.sensitive:null,entities:d.entities.total,documents:d.documents.total,embeddings:d.embeddings?.available===true?'AVAILABLE':'UNAVAILABLE',contents:'not projected'};
 }
 if(namespace==='context'){
  const d=body.data;if(!d.ai||typeof d.ai!=='object')throw Error('UNRECOGNIZED_CORE_CATALOG');
  const agents=Array.isArray(d.agents?.agents)?d.agents.agents:[];
  return {provider:safeLabel(d.ai.platform)?d.ai.platform.trim():'UNKNOWN',model:safeLabel(d.ai.model)?d.ai.model.trim():'UNKNOWN',memory:{memories:count(d.memory?.memories)?d.memory.memories:null,entities:count(d.memory?.entities)?d.memory.entities:null},integrations:{total:count(d.integrations?.total)?d.integrations.total:null,online:count(d.integrations?.online)?d.integrations.online:null},agentsOnline:agents.filter(a=>a?.online===true).length,contextWindowOccupancy:'UNAVAILABLE_NOT_REPORTED_BY_CORE'};
 }
 throw Error('CORE_CATALOG_CONTRACT_ABSENT');
}
async function readCatalog(client,namespace,{signal}={}){
 const contract=contracts[namespace];if(!contract)throw Error('UNKNOWN_CORE_NAMESPACE');
 if(!contract.route)return {state:'UNAVAILABLE',namespace,reason:'NO_ESTABLISHED_CORE_SKILLS_HTTP_CONTRACT',authority:'Core only',registryCreated:false};
 const response=await client.request(contract.route,{role:'requester',signal});
 if(!response.ok){
  if(![401,403,404,405,409,503].includes(response.status))throw Error('CORE_CATALOG_READ_FAILED');
  return {state:'UNAVAILABLE',namespace,httpStatus:response.status,reason:response.status===404?'ROUTE_NOT_MOUNTED_IN_ACTIVE_CORE':response.status===401||response.status===403?'CORE_AUTHORIZATION_REQUIRED':'CORE_CATALOG_UNAVAILABLE',authority:'Core only',registryCreated:false};
 }
 return {state:'READ_ONLY',namespace,data:project(namespace,response.body),authority:'Core HTTP readback',executionEnabled:false};
}
module.exports={contracts,project,readCatalog};
