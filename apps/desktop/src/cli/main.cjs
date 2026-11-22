'use strict';
const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path');
const {InterruptController}=require('./interrupt.cjs');
const {OwnedWork}=require('./owned-work.cjs');
const {ServiceClient}=require('./service.cjs');
const {definitions,parseServiceCommand,CommandEngine,isMutation}=require('./commands.cjs');
const {TerminalInput}=require('./input.cjs');
const appearance=require('./appearance.cjs');
const registry=require('./command-registry.cjs');
const {SessionUsage}=require('./usage.cjs');
const hudState=require('./hud-state.cjs');
const {CoreReadClient}=require('./core-read-client.cjs');
const {SessionHistory}=require('./session-history.cjs');
const {restartCoreSession,writeCliResumeMarker}=require('./core-restart.cjs');
const {createSessionUI,listText}=require('./session-ui.cjs');
const {runTurn,workspace,localCommand,runLocal}=require('./agent-turn.cjs');
const {discussCommand,runDiscussion,teamText}=require('./discussion.cjs');
const endpoint=require('./core-endpoint.cjs').coreEndpoint();
const STATES=Object.freeze(['IDLE','INPUT_EDIT','OVERLAY','RUNNING','INTERRUPT_REQUESTED','CANCELLING','CANCELLED_CONFIRMED','COMPLETED','FAILED','OUTCOME_UNKNOWN_HELD','RECONCILING','EXITING']);
const commands=registry.reads;
 const QUICK_START_ID=Object.freeze(['discuss <topik>  - tim Pandawa berdiskusi; DAMAR memberi keputusan (team: siapa memakai model apa)','delegate janaka: tugas; sadewa: tugas  - subtugas paralel, DAMAR menggabungkan','sessions  - buka sesi tersimpan (dari shell: damar resume <id>)','/reload  - muat ulang tampilan dari profil tersimpan','/restart  - restart Core dengan aman, sambungkan kembali sesi, lalu muat ulang CLI','exit  - simpan sesi ini lalu keluar; pekerjaan lokal yang berjalan dihentikan, run sub-agent di Core tetap tercatat di Core',
  '/core status  - status lifecycle Core','/core restart  - restart Core dengan pemeriksaan pekerjaan dan sesi',
 'status  - apakah Core online?','settings  - pusat kontrol (provider, model, tema, bahasa, keamanan)','connect  - hubungkan provider pilihan Anda (OpenAI, OpenRouter, Ollama, endpoint OpenAI-compatible mana pun)',
 'model  - pilih model dari provider aktif','subagent run sadewa <tugas>  - delegasikan ke spesialis Pandawa (meminta persetujuan Anda)','usage  - token sesi dari bukti Core',
 'help <perintah>  - detail satu perintah; Tab menampilkan semua perintah']);
function parse(line){const parts=line.trim().replace(/^\//,'').split(/\s+/);let command=registry.canonicalName(parts.shift());if(!Object.hasOwn(commands,command))throw Error('UNKNOWN_COMMAND: use help');if(command==='diagnostic'&&parts.length===1&&parts[0]==='blocked')return {command,mode:'uncooperative'};if(command==='supervisor'){if(parts.length!==1||parts[0]!=='status')throw Error('SUPERVISOR_STATUS_ONLY');return {command};}if(parts.length)throw Error('UNEXPECTED_ARGUMENT: '+command+' accepts no arguments');return {command};}
function parseArguments(args){
 const result={},positional=[];
 for(let i=0;i<args.length;i++){
  const flag=args[i];if(flag==='--help'){if(args.length!==1)throw Error('HELP_ACCEPTS_NO_FLAGS');return {command:'help'};}
  // Subcommands: `resume [session-id]` and `sessions`; every other bare word is rejected.
  if(!flag.startsWith('--')&&(positional.length||['resume','sessions'].includes(flag))){positional.push(flag);continue;}
  if(!['--session','--command','--profile'].includes(flag)||Object.hasOwn(result,flag))throw Error('UNKNOWN_OR_DUPLICATE_FLAG');
  const value=args[++i];if(!value||value.startsWith('--'))throw Error('MISSING_FLAG_VALUE');result[flag]=value;
 }
 const directory=result['--session'];if(directory&&!path.isAbsolute(directory))throw Error('ABSOLUTE_SESSION_REQUIRED');
 const command=result['--command']?parse(result['--command']).command:undefined;
  if(['exit','diagnostic','clear','reload','restart'].includes(command))throw Error('COMMAND_REQUIRES_INTERACTIVE_SESSION');
 // Private cross-session profile (appearance + last provider/model). Never the original W5 ~/.damar state.
 const profile=result['--profile'];
 if(profile&&(!path.isAbsolute(profile)||path.resolve(profile).toLowerCase().startsWith(path.join(require('node:os').homedir(),'.damar').toLowerCase())))throw Error('PRIVATE_PROFILE_PATH_REFUSED');
 const [verb,resumeId,...extra]=positional;
 if(extra.length||verb==='sessions'&&resumeId!==undefined)throw Error('UNEXPECTED_ARGUMENT');
 if(resumeId!==undefined&&!/^[a-f0-9]{8,64}$/i.test(resumeId))throw Error('INVALID_SESSION_ID');
 if(verb&&command)throw Error('SUBCOMMAND_WITH_COMMAND_FLAG');
  return {directory,command,profile,verb,resumeId:resumeId?.toLowerCase()};
 }
function reloadProfile(rl){
  if(!rl.settings)throw Error('PRIVATE_PROFILE_REQUIRED');
  const saved=rl.settings.load();
  rl.theme=saved.theme;rl.bannerMode=saved.animate_banner?'flame':'static';
  rl.language=saved.language==='id'?'id':'en';rl.hudPosition=saved.hud_position||'left';
  rl.notice=rl.language==='en'?'Saved CLI appearance reloaded. Provider and model were not changed.':'Tampilan profil CLI dimuat ulang. Provider dan model tidak diubah.';
  rl.render();return saved;
}
function session(directory){if(!directory||!path.isAbsolute(directory))throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');let descriptor;try{descriptor=JSON.parse(fs.readFileSync(path.join(directory,'session.json'),'utf8'));}catch{throw Error('INVALID_PRIVATE_SESSION');}if(descriptor.address!==endpoint)throw Error('SESSION_ENDPOINT_MISMATCH');if(descriptor.authority!=='isolated-test')throw Error('SESSION_AUTHORITY_MISMATCH');return {directory,descriptor};}
async function run(command,{directory,signal,usage,client,language}={}){
  if(command==='reload'||command==='restart')throw Error('COMMAND_REQUIRES_INTERACTIVE_SESSION');
  // A session-bound client reads usage for the current session; otherwise the directory's own client.
  if(command==='usage'&&client)return client.usage(signal);
  if(command==='help'&&language==='id')return {...await run('help',{}),quickStart:QUICK_START_ID};
  if(command==='usage'){if(directory){session(directory);return new ServiceClient({sessionDirectory:directory,intentDirectory:path.join(directory,'cli-intents')}).usage(signal);}return {...(usage||new SessionUsage()).snapshot(),sessionMode:'no private session: no Core dispatch possible, so no inference and no receipts'};}
  if(command==='help')return {support:(({issues,discussions,license})=>({issues,discussions,license}))(require('../control/support-links.js')),quickStart:['discuss <topic>  - the Pandawa team debates it; DAMAR gives a decision (team: who uses which model)','delegate janaka: task; sadewa: task  - parallel subtasks, DAMAR merges','sessions  - open a saved session (damar resume <id> from the shell)','exit  - save this session and leave; local work in progress is stopped, Core sub-agent runs keep their own state','status  - is Core online?','settings  - control center (provider, model, theme, safety)','connect  - connect a provider of your choice (OpenAI, OpenRouter, Ollama, any OpenAI-compatible endpoint)','model  - choose a model from the active provider','subagent run sadewa <task>  - delegate to a Pandawa specialist (asks your approval)','usage  - session tokens from Core receipts','help <command>  - details for one command; Tab browses all commands'],version:'cli-pre-acceptance-0.9',candidateCloseReady:false,commands,canonicalCommands:registry.entries.map(e=>e.name+'  '+e.usage+'  ['+e.kind+'; '+e.authorization+']'),compatibilityAliases:registry.aliases,unavailableCapabilities:registry.unavailable,interactiveAppearanceCommands:appearance.definitions,appearanceAliases:appearance.aliases,appearancePersistence:'Theme/banner persist only within an explicit private session profile; sidebar/details remain session-only. Original personal configuration is never imported.',interactiveServiceCommands:definitions,keymap:{Enter:'submit draft',CtrlJ:'insert newline',Esc:'interrupt foreground work; dismiss Owner confirmation or search; idle clears editor',DoubleEsc:'release and repress within 700ms escalates owned fixed diagnostic worker only; native held repeat is ignored',CtrlC:'interrupt foreground work or clear input',CtrlD:'exit empty editor, otherwise delete at cursor',UpDown:'W5 transcript scroll; engineering line mode uses history',CtrlUpDown:'W5 session-only allowlisted read-command history',CtrlHomeEnd:'W5 transcript oldest/latest',Tab:'W5 canonical command picker; selection inserts draft without executing',CtrlR:'reverse history search, Enter accepts, Esc restores draft',CtrlL:'clear visible display; terminal owns scrollback',CtrlLeftRight:'word navigation',HomeEnd:'line start/end',Paste:'Native Ctrl+V/right-click and multiline bursts remain drafts; 8192-byte maximum'},mutations:'Interactive bounded synthetic service actions require explicit private session. Owner actions require distinct confirmation. Read-only agents, MCP, Plugins, and Tools use existing Core GET routes and are projected as bounded summaries. They read the run-owned isolated Core host on 127.0.0.1:29623 using the private session console credential (START_DAMAR_CORE.ps1), or DAMAR_CORE_URL/DAMAR_TOKEN when explicitly set; a missing credential reports authorization unavailable. Skills and active orchestration are UNAVAILABLE without a verified Core contract. Live inference remains disabled; product gates incomplete.'};
 if(command==='session'){const s=session(directory);return {endpoint,authority:s.descriptor.authority,credentials:'not displayed',historyPersistence:false};}
 if(command==='doctor')return {endpoint,node:process.version,terminal:!!process.stdin.isTTY,pythonBridge:'inherited, not validated in this engineering shell',service:await run('status',{directory,signal})};
  // Model metadata comes from the Owner's own connections (model list); there is no built-in gateway catalog.
  if(command==='catalog')return {notice:'Model metadata comes from your own provider connections.',next:'model list [provider-id]'};
  const route=command==='jobs'?'/api/r6/state':command==='supervisor'?'/api/r7/supervisor/status':'/api/r7r3/overview';
 const headers={accept:'application/json'};
 if(command==='jobs'){session(directory);const credentials=JSON.parse(fs.readFileSync(path.join(directory,'credentials.json'),'utf8'));headers.authorization='Bearer '+credentials.requester;}
 const response=await fetch(endpoint+route,{headers,signal:signal||AbortSignal.timeout(3000),redirect:'error'});
  const body=await response.json();if(!response.ok)throw Error('SERVICE_DENIED_HTTP_'+response.status);
  if(command==='supervisor'){if(body.success!==true||typeof body.data?.enabled!=='boolean')throw Error('UNRECOGNIZED_READBACK');return {enabled:body.data.enabled,state:body.data,authority:'Core readback only; no supervisor mutation dispatched'};}
 if(command==='jobs'){if(body.success!==true||body.data?.authority!=='isolated-test')throw Error('UNRECOGNIZED_READBACK');return {jobs:body.data.jobs,plans:body.data.plans};}
 if(command==='status'){if(body.connection!=='online'||typeof body.runtimeInstanceId!=='string')throw Error('UNRECOGNIZED_READBACK');return {endpoint,connection:body.connection,runtimeInstanceId:body.runtimeInstanceId,jobs:body.jobs.length,supervisor:body.supervisor.enabled?'ON':'OFF',provider:body.provider.kind};}
 return body;
}
async function main(args=process.argv.slice(2),{prototype=false}={}){
 let {directory,command:oneShot,profile,verb,resumeId}=parseArguments(args);
 if(oneShot){console.log(JSON.stringify(await run(oneShot,{directory}),null,2));return;}
 // The profile remembers the last private Core data directory, so `damar resume <id>` and `damar sessions` need no flags.
 let stored={};if(profile){try{stored=new (require('./ui-settings.cjs').UISettings)(profile).load();}catch{}}
 if(!directory&&stored.core_session&&fs.existsSync(path.join(stored.core_session,'session.json')))directory=stored.core_session;
 let language=stored.language==='id'?'id':'en';
 const say=(id,en)=>language==='id'?id:en;
 if(verb==='sessions'){
  // Interface language is a Core setting (cli.language, shared with DAMAR Control); the local profile is only a fallback.
  if(directory)try{const r=await new ServiceClient({sessionDirectory:directory,intentDirectory:path.join(directory,'cli-intents')}).r9('/api/r9/cli/settings');const c=r.ok?r.body?.data:null;if(c)language=(c.cli||c.defaults).language==='id'?'id':'en';}catch{}
  if(!directory){console.log(say('Tidak ada sesi Core privat. Mulai Core dengan START_DAMAR_CORE.ps1 lalu jalankan damar.','No private Core session. Start Core with START_DAMAR_CORE.ps1, then run damar.'));process.exitCode=1;return;}
  const history=new SessionHistory(new ServiceClient({sessionDirectory:directory,intentDirectory:path.join(directory,'cli-intents')}));
  try{console.log(listText((await history.list()).sessions,say));}
  catch(error){console.log(say('Daftar sesi tidak tersedia: ','Session list unavailable: ')+safeError(error)+'\n'+(HINTS[safeError(error)]||''));process.exitCode=1;}
  return;
 }
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('INTERACTIVE_TTY_REQUIRED: --help is available without a console');
    let state='IDLE',active=null,worker=null,ownerPrompt=null,restartRequested=false,restartSessionId=null;const usage=new SessionUsage(),hud=hudState.createHud();
  const coreClient=new CoreReadClient({sessionDirectory:directory});
  const engine=directory?new CommandEngine(new ServiceClient({sessionDirectory:directory,intentDirectory:path.join(directory,'cli-intents')}),{coreClient}):null;
  const coreReadEngine=new CommandEngine(null,{coreClient});
    const rl=prototype?new (require('./w5-input.cjs').W5Input)({nativeInput:process.platform==='win32'}):new TerminalInput();
     rl.readCommands={...commands,...definitions,...appearance.definitions};rl.usage=usage;rl.hud=hudState.projection(hud);
    let sessions=null;
    const updateHud=(name,result)=>{hudState.updateHud(hud,name,result);rl.hud=hudState.projection(hud);rl.render();sessions?.model(result);};
    let syncCliSettings=async()=>{};
    const setHudState=value=>{hud.viewState=value;rl.hud=hudState.projection(hud);rl.render();};
   if(prototype&&(profile||directory)){
    // Appearance lives in Core (cli.*); the profile keeps only core_session. Reads: any CLI credential; writes: Owner + attached session.
    const cliCore=engine?{read:async()=>{const r=await engine.client.r9('/api/r9/cli/settings');if(!r.ok)throw Error(r.body?.error||'CORE_UNREACHABLE');return r.body.data;},
     write:async cli=>{const r=await engine.client.r9('/api/r9/settings',{method:'POST',role:'owner',body:{action:'update',cliSession:history.id,client:history.clientId,values:{cli}}});if(!r.ok)throw Error(r.body?.error||'CORE_SETTINGS_FAILED');return r.body.data.cli;},
     canWrite:()=>!!history?.id}:null;
    rl.settings=new (require('./ui-settings.cjs').UISettings)(profile||directory,{core:cliCore});
    try{const settings=rl.settings.load();rl.theme=settings.theme;rl.bannerMode=settings.animate_banner?'flame':'static';rl.language=settings.language==='id'?'id':'en';rl.hudPosition=settings.hud_position||'left';}catch{rl.print('INVALID_UI_SETTINGS; original defaults retained; private settings were not overwritten.');rl.settings=null;}
    // Pull Core's cli.* (and import a legacy local profile once), then show it. Offline: last-known values, read-only.
    syncCliSettings=async()=>{if(!rl.settings)return;const v=await rl.settings.sync();rl.theme=v.theme;rl.bannerMode=v.animate_banner?'flame':'static';rl.language=v.language==='id'?'id':'en';rl.hudPosition=v.hud_position||'left';rl.settingsOffline=rl.settings.offline;rl.render();};
    rl.persistAppearance=()=>Promise.resolve().then(()=>rl.settings?.save({theme:rl.theme,bannerMode:rl.bannerMode,language:rl.language,hudPosition:rl.hudPosition})).catch(e=>{rl.notice=(rl.language==='en'?'Not saved (Core settings are read-only now): ':'Tidak disimpan (pengaturan Core hanya-baca saat ini): ')+safeError(e);rl.render();});
    if(rl.settings&&directory)try{rl.settings.save({coreSession:directory});}catch{}
   }
  // Settings Control Center dependencies: Core reads (providers, models, sandbox), the Owner-confirmed provider apply,
  // the private profile and the same command path a typed command takes. Without a Core session `core` is null.
  if(prototype){const sub=require('./subagents.cjs');
   rl.settingsDeps={
    core:engine?async()=>{await syncCliSettings();const provider=await sub.providers(engine.client);let sandbox=null,settings=null;try{const r=await engine.client.r9('/api/r9/sandbox');if(r.ok)sandbox=r.body?.data||null;}catch{}try{if(history?.id){const r=await engine.client.r9('/api/r9/settings',{method:'POST',role:'owner',body:{action:'read',cliSession:history.id,client:history.clientId}});if(r.ok)settings=r.body?.data||null;}}catch{}return {provider,sandbox,settings};}:null,
    models:id=>sub.models(engine.client,id),
     applyProvider:draft=>sub.applyProvider(engine.client,draft,{confirmOwner:binding=>rl.confirmOwner(binding)}),
     revokeProvider:provider=>sub.revokeProvider(engine.client,provider,{confirmOwner:binding=>rl.confirmOwner(binding)}),
    applySettings:async values=>{if(!history?.id)throw Error('CLI_SESSION_REQUIRED');const decision=await rl.confirmPermission({tool:'core_settings',change:'change persistent Core settings',scope:'this Core session',risk:'Changes agent permissions and skill routing'});if(decision==='deny')throw Error('OWNER_CONFIRMATION_CANCELLED');const r=await engine.client.r9('/api/r9/settings',{method:'POST',role:'owner',body:{action:'update',cliSession:history.id,client:history.clientId,values}});if(!r.ok)throw Error(r.body?.error||'CORE_SETTINGS_FAILED');return r.body.data;},
    trustPlugin:async(key,trusted)=>{if(!history?.id)throw Error('CLI_SESSION_REQUIRED');const decision=await rl.confirmPermission({tool:'plugin_trust',change:(trusted?'trust':'untrust')+' project plugin '+key,scope:'current workspace',risk:'Changes whether this exact plugin digest is trusted'});if(decision==='deny')throw Error('OWNER_CONFIRMATION_CANCELLED');const r=await engine.client.r9('/api/r9/settings',{method:'POST',role:'owner',body:{action:'trust-plugin',cliSession:history.id,client:history.clientId,key,trusted}});if(!r.ok)throw Error(r.body?.error||'PLUGIN_TRUST_FAILED');return r.body.data;},
    selected:result=>updateHud('provider',result),
    persist:async values=>{if(!rl.settings)throw Error('PRIVATE_PROFILE_REQUIRED');await rl.settings.save(values);},
    close:message=>{rl.settingsCenter=null;if(message)rl.notice=message;rl.render();},
    run:line=>rl.emit('line',line),
   };}
  // Every transcript line is journaled to the Core session ledger exactly as displayed (free text stays masked).
  // The startup notice belongs to the intro; once the transcript has content it is cleared so key hints stay visible.
  let startupNotice=null;
  const print=message=>{if(startupNotice&&rl.notice===startupNotice)rl.notice=null;rl.print(message);sessions?.sync();};
  const history=prototype&&engine?new SessionHistory(engine.client):null;
  let current=null;
  sessions=createSessionUI({rl,history,tr:(id,en)=>rl.language==='id'?id:en,print,updateHud,isBusy:()=>!!active});
  rl.on('sessionPick',id=>{sessions.picked(id);});
  const show=(result,title)=>prototype?hudState.formatResult(result,title):JSON.stringify(result,null,2);
  rl.on('rendererFailure',()=>{process.exitCode=1;});
 // The W5 intro owns the empty transcript; startup guidance lives in the footer notice so the intro stays visible.
 // UI language (profile `language`, default Indonesian). Status codes and receipts stay untranslated.
 if(rl.language!=='id')rl.language='en';
 const tr=(id,en)=>rl.language==='id'?id:en;
 startupNotice=tr('Baru di sini? Ketik help, tekan Tab untuk melihat perintah, atau klik Setting (kanan atas) / ketik settings.','New here? Type help, press Tab to browse commands, or click Setting (top right) / type settings.');
 if(prototype)rl.notice=startupNotice;else print('DAMAR CLI pre-acceptance | 127.0.0.1:29623 | NOT REVIEW READY\n'+startupNotice);
  // Restore the last provider/model saved in the private profile (an earlier Owner-confirmed choice).
 // New session, `resume <id>` or the startup picker (`resume`); history failures are reported, never hidden.
 const sessionsReady=Promise.resolve(sessions.start({verb,resumeId,saved:{provider:stored.provider,model:stored.model}})).catch(()=>{});
  if(engine&&rl.settings){let seen=null;const poll=setInterval(async()=>{if(state!=='IDLE'||rl.settingsCenter||ownerPrompt)return;try{const r=await engine.client.r9('/api/r9/cli/settings');const rev=r.ok?r.body?.data?.revision:null;if(rev===null||rev===undefined)return;if(seen!==null&&rev!==seen)await syncCliSettings();seen=rev;}catch{}},4000);poll.unref?.();rl.once?.('close',()=>clearInterval(poll));}
  if(engine&&rl.settings)sessionsReady.then(syncCliSettings).then(()=>{let saved=null;try{saved=rl.settings.load();}catch{}
   if(saved?.provider)require('./subagents.cjs').select(engine.client,saved.provider,saved.model).then(r=>{
    const say=text=>{if(prototype&&!rl.messages?.length){rl.notice=text;rl.render();}else print(text);};
    if(r.state==='SELECTED'){say(tr('Dipulihkan dari profil: provider ','Restored from profile: provider ')+r.provider+', model '+r.model+(r.executable?'':tr(' (live: perlu model grant)',' (live: needs a model grant)')));updateHud('provider',r);}
    else say(tr('Provider/model tersimpan ','Saved provider/model ')+saved.provider+'/'+saved.model+tr(' tidak dapat dipulihkan (',' could not be restored (')+(r.error||'REJECTED')+tr('). Profil tidak diubah. ','). Profile kept unchanged. ')+(r.hint||tr('Pilih lagi dengan: model pick','Choose again with: model pick')));
   },()=>{const text=tr('Provider/model tersimpan tidak dapat dipulihkan: Core tidak terjangkau. Profil tidak diubah.','Saved provider/model could not be restored: Core unreachable. Profile kept unchanged.');if(prototype&&!rl.messages?.length){rl.notice=text;rl.render();}else print(text);});});
 // Resumed session with interrupted agent work: say so once, with the way to continue it (nothing is replayed).
 if(prototype&&engine)sessionsReady.then(async()=>{if(!history?.id)return;try{const r=await engine.client.r9('/api/r9/turns/interrupted',{method:'POST',role:'owner',body:{cliSession:engine.client.sessionId,client:history.clientId,action:'get'}});const d=r.body?.data;
  if(r.ok&&d){rl.interruptedTurn=d;print(tr('Pekerjaan sebelumnya terputus: "','Earlier work was interrupted: "')+String(d.text).slice(0,120)+'"'+(d.steps.length?tr(' (langkah selesai: ',' (completed steps: ')+d.steps.length+')':'')+tr('. Ketik /continue untuk melanjutkan atau /dismiss untuk mengabaikan.','. Type /continue to resume it or /dismiss to drop it.'));}}catch{}});
 const prompt=()=>{state='INPUT_EDIT';rl.prompt();};
  const cancellation=new InterruptController({acknowledge:()=>{state='INTERRUPT_REQUESTED';setHudState('INTERRUPT');if(current?.command!=='agent')print('Interrupt requested… '+cancellation.operation.id);},dispatch:()=>{if(worker)worker.cancel();else active?.abort();state='CANCELLING';if(current?.command!=='agent')print('Cancel dispatched '+cancellation.operation.id+'; waiting for confirmed outcome.');},escalate:()=>worker?.escalate()});
   const interrupt=(event={})=>{if(ownerPrompt){const resolve=ownerPrompt;ownerPrompt=null;resolve(false);rl.write(null,{ctrl:true,name:'u'});print('Owner confirmation dismissed; no privileged action sent.');}else if(active){if(typeof rl.scroll==='number')rl.scroll=0;cancellation.escape(event);}else{rl.write(null,{ctrl:true,name:'u'});print('Input cleared.');prompt();}};
 // One agent turn: Core's agent loop with workspace tools; consequential tools ask on the permission card; Esc cancels.
 const agentTurn=async text=>{
  if(!engine){print(tr('Agen memerlukan sesi Core privat. Mulai Core dengan START_DAMAR_CORE.ps1, lalu jalankan damar.','The agent needs a private Core session. Start Core with START_DAMAR_CORE.ps1, then run damar.'));prompt();return;}
  active=new AbortController();state='RUNNING';setHudState('BUSY');const operationId=require('node:crypto').randomUUID();current={operationId,command:'agent'};
  sessions.operation(operationId,'agent','RUNNING');cancellation.start({id:operationId,kind:'remote-mutation'});rl.activity=true;rl.agentActive=true;rl.turnStarted=Date.now();rl.render();
  try{
   // A prompt typed right after start waits for the session to open (bounded), then needs it.
   if(!history?.id)await Promise.race([sessionsReady,new Promise(r=>setTimeout(r,8000))]);
   if(!history?.id)throw Error('SESSION_NOT_OPEN');
   const final=await runTurn({client:engine.client,clientId:history.clientId,rl,text,cwd:workspace(),signal:active.signal,tr});
   state=final.status==='COMPLETED'?'COMPLETED':final.status==='CANCELLED'?'CANCELLED_CONFIRMED':'FAILED';
  }catch(e){state=active.signal.aborted?'OUTCOME_UNKNOWN_HELD':'FAILED';print(withHint(e,text));}
  finally{rl.activity=false;rl.agentActive=false;rl.turnStarted=null;sessions.sync();setHudState('DONE');if(state==='OUTCOME_UNKNOWN_HELD'){cancellation.unknown();cancellation.operation=null;}else cancellation.confirm(operationId,state);sessions.operation(operationId,'agent',state);current=null;active=null;if(!rl.closed)prompt();
   // Session tokens from Core receipts, refreshed after the turn (never blocks the next prompt).
   engine.client.usage().then(u=>{rl.usage={snapshot:()=>u};rl.render();},()=>{});}
 };
 rl.on('escape',interrupt);
 rl.on('inputError',code=>print(code));
 rl.on('SIGINT',interrupt);
   rl.on('line',async line=>{rl.notice=null;sessions.sync();if(ownerPrompt){const resolve=ownerPrompt;ownerPrompt=null;resolve(line.trim()==='OWNER CONFIRM');return;}
   // While a Pandawa discussion runs, a typed line is the Owner's interjection (Esc stops the discussion).
   if(rl.discussion&&line.trim()){rl.discussion.interject(line.trim().slice(0,2000)).catch(e=>print(withHint(e,line)));return;}
   if(active){print(prototype?tr('Damar masih bekerja. Tunggu sebentar atau tekan Esc untuk menghentikan.','Damar is still working. Wait, or press Esc to stop.'):'Operation active; no second operation sent.');return;}
   // /sessions [search]: the saved-session picker (keyboard, wheel, click, type to search).
   // Agent-era commands (review, diff, export, permission, sandbox) and honest refusals for unavailable design commands.
   const team=prototype&&discussCommand(line);
   if(team){
    if(!engine){print(tr('Tim Pandawa memerlukan sesi Core privat.','The Pandawa team needs a private Core session.'));prompt();return;}
    if(team.name==='team'){try{print(await teamText(engine.client,tr));}catch(e){print(withHint(e,line));}prompt();return;}
    if(team.error){print(tr('Format: /delegate janaka: tugas; sadewa: tugas','Usage: /delegate janaka: task; sadewa: task'));prompt();return;}
    active=new AbortController();state='RUNNING';setHudState('BUSY');const operationId=require('node:crypto').randomUUID();current={operationId,command:'agent'};
    sessions.operation(operationId,'discuss','RUNNING');cancellation.start({id:operationId,kind:'remote-mutation'});rl.activity=true;rl.agentActive=true;rl.turnStarted=Date.now();rl.render();
    try{if(!history?.id)await Promise.race([sessionsReady,new Promise(r=>setTimeout(r,8000))]);if(!history?.id)throw Error('SESSION_NOT_OPEN');
     const final=await runDiscussion({client:engine.client,clientId:history.clientId,rl,command:team,signal:active.signal,tr});
     state=final?.status==='COMPLETED'?'COMPLETED':final?.status==='CANCELLED'?'CANCELLED_CONFIRMED':'FAILED';}
    catch(e){state=active.signal.aborted?'CANCELLED_CONFIRMED':'FAILED';print(withHint(e,line));}
    finally{rl.activity=false;rl.agentActive=false;rl.turnStarted=null;sessions.sync();setHudState('DONE');cancellation.confirm(operationId,state);sessions.operation(operationId,'discuss',state);current=null;active=null;if(!rl.closed)prompt();}
    return;
   }
   const local=prototype&&localCommand(line);
   if(local){try{const r=await runLocal(local,{client:engine?.client,clientId:history?.clientId,rl,tr,profile});if(r?.turn){await agentTurn(r.turn);return;}if(r?.text)print(r.text);}catch(e){print(withHint(e,line));}prompt();return;}
   const sessionsLine=/^\/?sessions(?:\s+(.{1,40}))?$/.exec(line.trim());
   if(sessionsLine){if(!history)print(tr('Riwayat sesi memerlukan sesi Core privat. Mulai Core dengan START_DAMAR_CORE.ps1.','Session history needs a private Core session. Start Core with START_DAMAR_CORE.ps1.'));else try{await sessions.openPicker(sessionsLine[1]||'');}catch(e){print(withHint(e,line));}prompt();return;}
   let command,mode,serviceCommand;try{const topic=registry.contextualHelp(line);if(topic){print(show(topic,'help'));prompt();return;}const visual=appearance.parseAppearance(line);if(visual){if(!prototype)throw Error('W5_INTERACTIVE_REQUIRED');const applied=appearance.applyAppearance(rl,visual);
    // Settings and pickers open visually; applied appearance is confirmed in the footer instead of dumping JSON.
    const saved=applied.state==='APPLIED_PRIVATE_SESSION_PROFILE';
    if(visual.name!=='settings'&&!rl.pick)rl.notice=applied.command+tr(' diterapkan (',' applied (')+(saved?tr('disimpan ke DAMAR Core','saved to DAMAR Core'):tr('sesi ini','this session'))+'): theme '+applied.theme+', banner '+applied.banner+tr(', bahasa ',', language ')+(applied.language==='en'?'English':'Indonesia');
    prompt();return;}serviceCommand=parseServiceCommand(line);if(serviceCommand){if(!engine&&!['agents','mcp','plugins','tools','skills','safety','memory','context'].includes(serviceCommand.action))throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');command=serviceCommand.action;}else ({command,mode}=parse(line));}catch(e){
    // Anything that is not a command (and not /-prefixed) is a natural-language request for the agent.
    if(prototype&&/^UNKNOWN_COMMAND/.test(e?.message||'')&&!line.trim().startsWith('/')){await agentTurn(line.trim());return;}
     print(withHint(e,line));prompt();return;}
    if(command==='reload'){try{reloadProfile(rl);}catch(e){print(safeError(e));}prompt();return;}
     if(command==='restart'){
      if(process.env.DAMAR_CLI_RESTARTABLE!=='1'){print('RESTART_REQUIRES_LAUNCHER');prompt();return;}
      if(!prototype||!engine||!history?.id){print('CORE_RESTART_REQUIRES_PRIVATE_SESSION');prompt();return;}
      state='RUNNING';setHudState('BUSY');rl.activity=true;rl.render();
      try{
       await restartCoreSession({engine,history,sessions,confirmOwner:binding=>rl.confirmOwner?rl.confirmOwner(binding):Promise.resolve(false)});
       restartSessionId=history.id;
       print('Core restarted and the same session reattached. Reloading the CLI now.');
       restartRequested=true;state='EXITING';rl.close();
      }catch(e){state='FAILED';rl.activity=false;setHudState('DONE');print(withHint(e,line));prompt();}
      return;
    }
    if(command==='exit'){state='EXITING';rl.close();return;}if(command==='clear'){if(Array.isArray(rl.messages))rl.messages.length=0;else rl.output?.write('\x1b[2J\x1b[H');rl.scroll=0;print('Visible transcript cleared. Session, pending holds, history and Core state unchanged.');prompt();return;}
    if(serviceCommand?.action==='core'&&serviceCommand.op==='restart'){
     if(!prototype||!engine||!history?.id){print('CORE_RESTART_REQUIRES_PRIVATE_SESSION');prompt();return;}
     state='RUNNING';setHudState('BUSY');rl.activity=true;rl.render();
      try{
       await restartCoreSession({engine,history,sessions,confirmOwner:binding=>rl.confirmOwner?rl.confirmOwner(binding):Promise.resolve(false)});
       print('Core restarted cleanly; the same session was reattached. No work was replayed.');
     }catch(e){print(withHint(e,line));}
     finally{state='COMPLETED';rl.activity=false;setHudState('DONE');prompt();}
     return;
    }
   active=new AbortController();state='RUNNING';setHudState('BUSY');const operationId=require('node:crypto').randomUUID();current={operationId,command};sessions.operation(operationId,command,'RUNNING');cancellation.start({id:operationId,kind:command==='diagnostic'?'owned-local':serviceCommand&&isMutation(serviceCommand)?'remote-mutation':'read'});const timer=setTimeout(()=>{if(worker)worker.cancel();else if(!ownerPrompt)active?.abort();},command==='diagnostic'?10000:serviceCommand?30000:3000);
  rl.activity=true;rl.turnStarted=Date.now();rl.render();
  try{
   if(serviceCommand){
      const result=await (engine||coreReadEngine).dispatch(serviceCommand,{signal:active.signal,confirmOwner:async binding=>{
      state='OVERLAY';setHudState('PERMISSION');
      if(rl.confirmOwner){const approved=await rl.confirmOwner(binding);setHudState('BUSY');return approved;}
     print('OWNER-GATED '+binding.action+' '+binding.planId+' v'+binding.version+'\nUse only your authorized private Owner session. Type OWNER CONFIRM, or Esc to dismiss.');
      return new Promise(resolve=>{ownerPrompt=value=>{setHudState('BUSY');resolve(value);};});
    }});
     state=result.state==='OUTCOME_UNKNOWN_HELD'?'OUTCOME_UNKNOWN_HELD':'COMPLETED';updateHud(command,result);
      if(result.pick&&prototype){rl.pick=result.pick;print(result.help||'Choose with Up/Down and Enter; Esc cancels.');}else print(show(result,command));
      // Only a Core-confirmed selection is persisted; cancelled, denied or failed changes never touch the profile.
      if(result.state==='SELECTED'&&result.persist&&rl.settings){try{rl.settings.save(result.persist);}catch{print('UI_SETTINGS_SAVE_FAILED: selection applied in Core but not saved to profile.');}}
   }else if(command==='diagnostic'){
    worker=new OwnedWork({mode:mode||'cooperative',onEvent:event=>{if(event.type==='READY')print('RUNNING '+operationId+' owned diagnostic ready; Esc interrupts.');}});
    const result=await worker.done;state=result.requested?'CANCELLED_CONFIRMED':result.code===0?'COMPLETED':'FAILED';
    print(state+' '+operationId+' owned worker exited; runtime unchanged.');
    }else{const result=await run(command,{directory,signal:active.signal,usage,client:engine?.client,language:rl.language});if(command==='usage'&&result.source==='core-durable-receipts')rl.usage={snapshot:()=>result};updateHud(command,result);print(show(result,command));state='COMPLETED';}
   }catch(e){state=serviceCommand&&isMutation(serviceCommand)&&active.signal.aborted?'OUTCOME_UNKNOWN_HELD':active.signal.aborted?'CANCELLED_CONFIRMED':'FAILED';print(withHint(e,line));}finally{clearTimeout(timer);rl.activity=false;rl.turnStarted=null;setHudState('DONE');if(state==='OUTCOME_UNKNOWN_HELD'){cancellation.unknown();cancellation.operation=null;}else cancellation.confirm(operationId,state);sessions.operation(operationId,command,state);current=null;active=null;worker=null;if(!rl.closed)prompt();}
 });
 // Exit: CLI-owned work still running is stopped (its outcome is recorded as unconfirmed); Core-owned sub-agent runs
 // are not touched. The receipt is printed after the native terminal is restored and states only what Core confirmed.
 rl.once('close',()=>{state='EXITING';rl.exiting=true;if(ownerPrompt){ownerPrompt(false);ownerPrompt=null;}
  const interrupted=active?current:null;if(interrupted)sessions.operation(interrupted.operationId,interrupted.command,'OUTCOME_UNKNOWN','CLI_EXITED_DURING_OPERATION');
  worker?.cancel();active?.abort();
    const saved=sessions.receipt({interrupted}).then(text=>{console.log('\n'+text);return true;},()=>{console.log('\n'+tr('Status penyimpanan sesi tidak dapat dikonfirmasi.','The session save status could not be confirmed.'));return false;});
    if(restartRequested)Promise.all([saved,rl.native?.stoppedPromise||Promise.resolve(true)]).then(([receiptOk,inputRestored])=>{
     if(receiptOk&&inputRestored){try{writeCliResumeMarker(profile||directory,restartSessionId);process.exitCode=75;}catch{console.log('\nCLI tidak di-restart karena penanda sesi tidak dapat disimpan.');process.exitCode=1;}}
     else{console.log('\nCLI tidak di-restart karena status sesi/terminal tidak dapat dikonfirmasi.');process.exitCode=1;}
   });});
 prompt();
}
function safeError(error){return typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.message)?error.message:'CLI_FAILED: check runtime and private session; diagnostic details suppressed';}
// Beginner-facing recovery: a next step for common errors and closest-command suggestions. Text only.
const HINTS=Object.freeze({EXPLICIT_PRIVATE_SESSION_REQUIRED:'This needs a running private Core session: start START_DAMAR_CORE.ps1 -Session <dir>, then RUN_DAMAR_CLI.ps1 -Session <same dir>.',
 SERVICE_RESPONSE_UNAVAILABLE:'Core did not answer. Is START_DAMAR_CORE.ps1 still running for this session?',RUNTIME_OFFLINE:'Core is offline. Start it with START_DAMAR_CORE.ps1, then retry.',
 OWNER_CONFIRMATION_CANCELLED:'Nothing was changed.',TURN_STREAM_LOST:'Core stopped answering this turn. It may still be running in Core: type /continue once Core is reachable, or `damar resume` after a restart. Nothing was run twice.',TURN_LOST:'Core no longer knows this turn (its records were not found). Nothing was run twice.',CORE_CATALOG_LIST_ONLY:'Use the listed form, e.g. tools list, safety status, memory stats, context status.',
 SUBAGENT_USAGE:'Usage: subagent run <puntadewa|werkudara|janaka|nakula|sadewa> <task> | subagent list | subagent cancel <run-id> | subagent reconcile <request-id>',
 PROVIDER_USAGE:'Usage: provider status | provider use <provider-id> [model-id] | provider allow <provider-id> [days] | provider rename <provider-id> <label> | provider remove <provider-id>',CONNECT_USAGE:'Usage: connect | connect <name-or-preset> [base-url] [--key-env VARIABLE]  (e.g. connect openai --key-env OPENAI_API_KEY, connect ollama)',
 MODEL_USAGE:'Usage: model | model list [provider-id] | model pick [provider-id] | model use <model-id>',SYNTHETIC_TEXT_REQUIRED:'Add a short task text (no control characters, max 2000 characters).',
 PLAN_ID_AND_VERSION_REQUIRED:'Usage: <command> <plan-id> <version>. See plan ids with: jobs',LIVE_SESSION_APPROVAL_REQUIRED:'Approve the plan first in this CLI: approve <plan-id> <version>.'});
function suggest(word){
 const names=[...new Set([...Object.keys(commands),...Object.keys(definitions),...Object.keys(appearance.definitions),...Object.keys(registry.aliases)])];
 const dist=(a,b)=>{const d=Array.from({length:a.length+1},(_,i)=>[i]);for(let j=1;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length];};
 return word?names.filter(n=>n.startsWith(word)||dist(n,word)<=2).sort((a,b)=>dist(a,word)-dist(b,word)).slice(0,4):[];
}
function withHint(error,line=''){
 if(typeof error?.message==='string'&&error.message.startsWith('UNKNOWN_COMMAND')){
  const word=String(line).trim().replace(/^\//,'').split(/\s+/)[0].toLowerCase().slice(0,32),s=suggest(word);
  return 'UNKNOWN_COMMAND'+(s.length?'\nDid you mean: '+s.map(x=>'/'+x).join(', ')+' ?':'')+'\nType help for a guided overview, or press Tab to browse commands.';
 }
 const message=safeError(error),why=typeof error?.reason==='string'&&/^[A-Za-z0-9_]{1,40}$/.test(error.reason)?' ['+error.reason+']':'';
 return HINTS[message]?message+why+'\n'+HINTS[message]:message+why;
}
if(require.main===module)main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
module.exports={main,parse,parseArguments,run,STATES,commands,safeError,withHint,suggest,reloadProfile};
