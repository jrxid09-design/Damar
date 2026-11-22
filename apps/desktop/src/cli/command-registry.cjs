'use strict';
const {definitions:service}=require('./commands.cjs');
const appearance=require('./appearance.cjs');
const reads=Object.freeze({help:'Command discovery and keyboard guide',status:'Actual local overview',jobs:'Authenticated local job readback',doctor:'Endpoint and dependency status',session:'Nonsecret session description',usage:'Current CLI session token counts and unknown usage; not Core billing',supervisor:'Read-only Core supervisor status; never enables supervision',catalog:'Model metadata: use model list (your own connections)',diagnostic:'Bounded owned cooperative worker, no network or inference',clear:'Clear visible transcript only; session, history, pending holds and Core state are unchanged',reload:'Reload saved CLI appearance preferences without changing provider/model',restart:'Cleanly relaunch the CLI with this Core session and profile',exit:'Clean exit'});
const aliases=Object.freeze({'?':'help','quit':'exit','q':'exit','cost':'usage',...appearance.aliases});
const routes=Object.freeze({status:'/api/r7r3/overview',jobs:'/api/r6/state',catalog:'/api/r9/models',supervisor:'/api/r7/supervisor/status'});
// Core Pandawa run lifecycle and offline-fixture provider selection (src/core-host/r9-routes.cjs).
const r9=Object.freeze({subagent:{authorization:'owner-confirmation for run/cancel; requester-session for list/reconcile',handler:'subagents.dispatch',api:'/api/r9/pandawa/runs',status:'SUPPORTED_OFFLINE_FIXTURE_PROVIDER'},provider:{authorization:'owner-confirmation for use; requester-session for status',handler:'subagents.dispatch',api:'/api/r9/provider',status:'SUPPORTED_LIVE_PROVIDERS_CONFIGURE_ONLY'},connect:{authorization:'owner-confirmation for connect; requester-session for the provider picker',handler:'subagents.dispatch',api:'/api/r9/connect',status:'SUPPORTED_LIVE_PROVIDERS_CONFIGURE_ONLY'},model:{authorization:'owner-confirmation for use; requester-session for list/pick',handler:'subagents.dispatch',api:'/api/r9/models',status:'SUPPORTED_METADATA_ONLY_FOR_LIVE'}});
// Agent-era commands (src/cli/agent-turn.cjs runLocal / main.cjs): natural-language turns and their session services.
const agent=Object.freeze({
 review:{usage:'review [focus]',authorization:'agent turn; read-only tools',api:'/api/r9/turns',description:'Agent code review of the workspace (read-only)'},
 diff:{usage:'diff',authorization:'none',api:null,description:'Files Damar changed in this session'},
 export:{usage:'export',authorization:'none (writes only the private profile)',api:null,description:'Transcript to Markdown in the private profile'},
 permission:{usage:'permission',authorization:'none',api:null,description:'Shows the only autonomy profile: ask (approval per action)'},
 sandbox:{usage:'sandbox',authorization:'requester-session',api:'/api/r9/sandbox',description:'Workspace boundary and command policy from Core'},
 undo:{usage:'undo',authorization:'owner-confirmation (permission card) + session lease',api:'/api/r9/checkpoints',description:'Restore the files Damar changed in its last turn'},
 redo:{usage:'redo',authorization:'owner-confirmation (permission card) + session lease',api:'/api/r9/checkpoints',description:'Re-apply the change just undone'},
 checkpoints:{usage:'checkpoints',authorization:'owner session lease',api:'/api/r9/checkpoints',description:'List Damar file changes of this session'},
 continue:{usage:'continue',authorization:'owner session lease; every step asks again',api:'/api/r9/turns/interrupted',description:'Continue interrupted agent work as a new turn'},
 dismiss:{usage:'dismiss',authorization:'owner session lease',api:'/api/r9/turns/interrupted',description:'Drop interrupted agent work'},
 sessions:{usage:'sessions [search]',authorization:'requester-session',api:'/api/r9/sessions',description:'Saved-session picker from the Core session ledger'},
});
const entries=Object.freeze([
  ...Object.entries(reads).map(([name,description])=>Object.freeze({name,description,usage:name==='supervisor'?'supervisor status':name,kind:['diagnostic','exit','clear','reload','restart'].includes(name)?'interactive':'read',authorization:name==='jobs'||name==='session'?'requester-session':'none',handler:name==='diagnostic'?'OwnedWork':name==='exit'?'TerminalInput.close':name==='clear'?'main.clearVisible':['reload','restart'].includes(name)?'main.cliLifecycle':'main.run',api:routes[name]||null,status:['diagnostic','exit','clear','reload','restart'].includes(name)?'SUPPORTED':'READ_ONLY'})),
  ...Object.entries(service).map(([name,usage])=>Object.freeze({name,usage,kind:'service',authorization:['approve','revoke'].includes(name)?'owner-confirmation':['agents','mcp','plugins','tools','skills','safety','memory','context'].includes(name)?'Core console credential (private session or explicit env), read-only':'requester-session',handler:'CommandEngine.dispatch',api:['agents','mcp','plugins','tools','skills','safety','memory','context'].includes(name)?require('./core-catalog.cjs').contracts[name].route:['pending','reconcile'].includes(name)?null:'/api/r6/'+name,status:name==='skills'?'UNAVAILABLE_NO_CORE_SKILLS_CONTRACT':['agents','mcp','plugins','tools'].includes(name)?'CORE_READ_ONLY':['approve','revoke'].includes(name)?'OWNER_GATED':name==='pending'?'READ_ONLY':'SUPPORTED',...(r9[name]||{})})),
 ...Object.entries(agent).map(([name,a])=>Object.freeze({name,usage:a.usage,description:a.description,kind:'agent',authorization:a.authorization,handler:'agent-turn.runLocal('+name+')',api:a.api,status:'SUPPORTED_OFFLINE_FIXTURE_PROVIDER'})),
 ...Object.entries(appearance.definitions).map(([name,usage])=>Object.freeze({name,usage,kind:'appearance',authorization:'none',handler:'applyAppearance',api:null,status:'SUPPORTED',persistence:['themes','banner'].includes(name)?'explicit-private-session-profile; otherwise session-only':'session-only'})),
]);
if(new Set(entries.map(entry=>entry.name)).size!==entries.length)throw Error('DUPLICATE_CANONICAL_COMMAND');
for(const [alias,target] of Object.entries(aliases))if(entries.some(entry=>entry.name===alias)||!entries.some(entry=>entry.name===target))throw Error('INVALID_COMMAND_ALIAS');
function canonicalName(name){return aliases[name]||name;}
function describe(name){return entries.find(entry=>entry.name===canonicalName(name))||null;}
function contextualHelp(line){
 const parts=line.trim().replace(/^\//,'').split(/\s+/);
 if(!['help','?'].includes(parts[0])||parts.length===1)return null;
 if(parts.length!==2)throw Error('HELP_COMMAND_NAME_REQUIRED');
 const entry=describe(parts[1].replace(/^\//,''));
 if(!entry)throw Error('UNKNOWN_COMMAND');
 return {command:entry,aliases:Object.keys(aliases).filter(alias=>aliases[alias]===entry.name),example:entry.usage.replace('<synthetic text>','synthetic verification input').replace('<plan-id>','PLAN_ID').replace('<version>','1').replace('<operation-id>','OPERATION_ID'),execution:'Help never dispatches the operation'};
}
const unavailable=Object.freeze([
  {capability:'Skills catalog',status:'UNAVAILABLE',scope:'current canonical Core',reason:'No established Skills registry or HTTP contract exists; no local registry is created.'},
 {capability:'Live model inference',status:'UNAVAILABLE',reason:'Not authorized; catalog is metadata only.'},
 {capability:'Original provider/config/credential migration',status:'PROTOTYPE_ONLY',reason:'Original private configuration is not imported.'},
]);
module.exports={reads,agent,entries,aliases,canonicalName,describe,contextualHelp,unavailable};
