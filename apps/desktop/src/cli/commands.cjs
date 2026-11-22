'use strict';
const crypto=require('node:crypto');
const definitions=Object.freeze({
 plan:'plan <synthetic text>',approve:'approve <plan-id> <version>',execute:'execute <plan-id> <version>',
 revise:'revise <plan-id> <version> <synthetic text>',
 verify:'verify <plan-id> <version>',revoke:'revoke <plan-id> <version>',cancel:'cancel <plan-id> <version>',
  reconcile:'reconcile <operation-id>',pending:'pending',agents:'agents list',
  mcp:'mcp list',plugins:'plugins list',tools:'tools list',skills:'skills list',
  safety:'safety status',memory:'memory stats',context:'context status',
  subagent:'subagent run <worker> <synthetic task> | subagent list | subagent cancel <run-id> | subagent reconcile <request-id>',
 provider:'provider status | provider use <provider-id> [model-id] | provider allow <provider-id> [days] | provider rename <provider-id> <label> | provider remove <provider-id>',
 core:'core status | core restart',
  connect:'connect | connect <name-or-preset> [base-url] [--key-env VARIABLE]',
  model:'model | model list [provider-id] | model pick [provider-id] | model use <model-id>',
});
const CATALOG_ARG=Object.freeze({agents:'list',mcp:'list',plugins:'list',tools:'list',skills:'list',safety:'status',memory:'stats',context:'status'});
const readActions=Object.freeze(['pending','reconcile',...Object.keys(CATALOG_ARG)]);
// Accepts an action name or a parsed command; parsed subagent/provider commands carry their own mutating flag.
function isMutation(command){
 if(command&&typeof command==='object'){if(typeof command.mutating==='boolean')return command.mutating;command=command.action;}
 return Object.hasOwn(definitions,command)&&!readActions.includes(command);
}
const WORKERS='puntadewa|werkudara|janaka|nakula|sadewa';
function parseServiceCommand(line){
 const trimmed=line.trim().replace(/^\//,'');
 const match=/^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
 if(!match||!Object.hasOwn(definitions,match[1]))return null;
  const action=match[1],text=match[2]||'';
    if(Object.hasOwn(CATALOG_ARG,action)){if(text!==CATALOG_ARG[action])throw Error('CORE_CATALOG_LIST_ONLY');return {action};}
 if(action==='subagent'){
  if(text==='list')return {action,op:'list',mutating:false};
  const run=new RegExp('^run\\s+('+WORKERS+')\\s+([\\s\\S]+)$').exec(text);
  if(run){if(!run[2].trim()||run[2].length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(run[2]))throw Error('SYNTHETIC_TEXT_REQUIRED');return {action,op:'run',worker:run[1],task:run[2],mutating:true};}
  const cancel=/^cancel\s+(run_[a-f0-9]{32})$/.exec(text);if(cancel)return {action,op:'cancel',runId:cancel[1],mutating:true};
  const rec=/^reconcile\s+(req_[a-f0-9]{32})$/.exec(text);if(rec)return {action,op:'reconcile',requestId:rec[1],mutating:false};
  throw Error('SUBAGENT_USAGE');
 }
 // Provider/model ids are validated for shape here; whether they exist is decided by Core's provider registry.
 if(action==='provider'){
  if(text==='status')return {action,op:'status',mutating:false};
  const use=/^use\s+([a-z0-9-]{1,32})(?:\s+([A-Za-z0-9._:\/@+-]{1,128}))?$/.exec(text);if(use)return {action,op:'use',provider:use[1],model:use[2],mutating:true};
  // Connection management: allow = Owner grant for every model of this connection (default 30 days, max 365).
  const allow=/^allow\s+([a-z0-9-]{1,32})(?:\s+([1-9][0-9]{0,2}))?$/.exec(text);if(allow&&Number(allow[2]||30)<=365)return {action,op:'allow',provider:allow[1],days:Number(allow[2]||30),mutating:true};
  const rename=/^rename\s+([a-z0-9-]{1,32})\s+([^\x00-\x1f\x7f]{1,64})$/.exec(text);if(rename&&rename[2].trim())return {action,op:'rename',provider:rename[1],label:rename[2].trim(),mutating:true};
  const remove=/^remove\s+([a-z0-9-]{1,32})$/.exec(text);if(remove)return {action,op:'remove',provider:remove[1],mutating:true};
  throw Error('PROVIDER_USAGE');
 }
 if(action==='connect'){
  if(!text)return {action,op:'pick',mutating:false};
  const m=/^([a-z0-9-]{1,32})(?:\s+(https?:\/\/[^\s]{1,200}))?(?:\s+--key-env\s+([A-Z_][A-Z0-9_]{0,63}))?$/.exec(text);
  if(m)return {action,op:'connect',provider:m[1],baseUrl:m[2],keyEnv:m[3],mutating:true};
  throw Error('CONNECT_USAGE');
 }
  if(action==='model'){
  if(!text||text==='pick')return {action,op:'pick',mutating:false};
  if(text==='list')return {action,op:'list',mutating:false};
  let m=/^(pick|list)\s+([a-z0-9-]{1,32})$/.exec(text);if(m)return {action,op:m[1],provider:m[2],mutating:false};
  m=/^use\s+([A-Za-z0-9._:\/@+-]{1,128})$/.exec(text);if(m)return {action,op:'use',model:m[1],mutating:true};
  throw Error('MODEL_USAGE');
 }
 if(action==='plan'){
  if(!text.trim()||Buffer.byteLength(text)>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw Error('SYNTHETIC_TEXT_REQUIRED');
  return {action,body:{text,syntheticData:true}};
 }
 const parts=text?text.split(/\s+/):[];
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
  if(action==='revise'){
   const revision=/^(\S+)\s+([1-9][0-9]{0,6})\s+([\s\S]+)$/.exec(text);
   if(!revision||!id(revision[1]))throw Error('PLAN_ID_AND_VERSION_REQUIRED');
   const content=revision[3];if(!content.trim()||Buffer.byteLength(content)>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))throw Error('SYNTHETIC_TEXT_REQUIRED');
   return {action,body:{planId:revision[1],version:Number(revision[2]),text:content,syntheticData:true}};
  }
  if(action==='core'){
   if(text==='status')return {action,op:'status',mutating:false};
   if(text==='restart')return {action,op:'restart',mutating:true};
   throw Error('CORE_USAGE');
  }
 if(action==='pending'){if(parts.length)throw Error('UNEXPECTED_ARGUMENT');return {action};}
 if(action==='reconcile'){if(parts.length!==1||!id(parts[0]))throw Error('OPERATION_ID_REQUIRED');return {action,operationId:parts[0]};}
 if(parts.length!==2||!id(parts[0])||!/^[1-9][0-9]{0,6}$/.test(parts[1]))throw Error('PLAN_ID_AND_VERSION_REQUIRED');
 return {action,body:{planId:parts[0],version:Number(parts[1])}};
}
class CommandEngine{
 constructor(client,{coreClient=client}={}){this.client=client;this.coreClient=coreClient;}
 async dispatch(parsed,{signal,confirmOwner=async()=>false}={}){
  const {action,body}=parsed;
   if(!Object.hasOwn(definitions,action))throw Error('UNKNOWN_COMMAND');
   if(action==='core'){
    if(!this.client)throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');
    if(parsed.op==='status'){
     const r=await this.client.r9('/api/r9/lifecycle',{signal});if(!r.ok||r.body?.success!==true||typeof r.body.data?.state?.state!=='string')throw Error('UNRECOGNIZED_CORE_LIFECYCLE_READBACK');
     return {state:'CORE_LIFECYCLE',...r.body.data};
    }
    if(!await confirmOwner({action:'core restart',change:'gracefully restart Core',scope:'same isolated Core session',risk:'Active work is preserved; restart is refused while jobs, turns, permissions, or Pandawa runs are outstanding'}))throw Error('OWNER_CONFIRMATION_CANCELLED');
    const r=await this.client.r9('/api/r9/lifecycle/restart',{method:'POST',role:'owner',body:{},signal});
    if(!r.ok||r.body?.success!==true)throw Error(r.body?.error||'CORE_RESTART_REJECTED');
    return {state:'CORE_RESTART_ACCEPTED',restart:r.body.data};
   }
   if(action==='pending')return {pending:this.client.intents.list()};
    if(Object.hasOwn(CATALOG_ARG,action))return require('./core-catalog.cjs').readCatalog(this.coreClient,action,{signal});
  if(['subagent','provider','connect','model'].includes(action)){if(!this.client)throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');return require('./subagents.cjs').dispatch(this.client,parsed,{signal,confirmOwner});}
  if(action==='reconcile')return this.client.reconcile(parsed.operationId,{signal});
  const role=['approve','revoke'].includes(action)?'owner':'requester';
  if(role==='owner'&&!await confirmOwner({action,planId:body.planId,version:body.version}))throw Error('OWNER_CONFIRMATION_CANCELLED');
  let request=body;
  if(action==='execute'){
   const grant=this.client.grants.get(body.planId);
   if(!grant||grant.expiresAt<=Date.now())throw Error('LIVE_SESSION_APPROVAL_REQUIRED');
   if(await this.client.identity(signal)!==grant.runtimeId)throw Error('APPROVAL_RUNTIME_CHANGED');
   request={...body,approvalId:grant.approvalId,requestId:crypto.randomUUID()};
  }
  return this.client.mutate(action,request,{role,signal});
 }
}
module.exports={definitions,parseServiceCommand,CommandEngine,isMutation,CATALOG_ARG};
