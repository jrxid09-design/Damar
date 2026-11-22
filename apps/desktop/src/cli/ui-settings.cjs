'use strict';
// CLI settings, one source of truth in Core. Appearance (theme, banner, language, HUD dock) lives in Core settings `cli.*`
// (GET /api/r9/cli/settings; Owner writes via /api/r9/settings values.cli with the attached CLI session) and is shared
// with DAMAR Control. Provider/model selection stays with POST /api/r9/provider; Core remembers the last accepted pair.
// Only `core_session` (this client's pointer to its private Core data directory) is stored locally.
// A legacy local profile (appearance/provider/model keys) is imported into Core once, then those keys are dropped.
// Without Core the last-known values are shown read-only; nothing is written locally instead.
// Strict validation; an invalid file is reported and never silently overwritten. Writes are atomic.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {themes}=require('./appearance.cjs');
const PROVIDER=/^[a-z0-9-]{1,32}$/,MODEL=/^[A-Za-z0-9._:\/@+-]{1,128}$/;
const KEYS=['animate_banner','core_session','hud_position','language','model','provider','schema','theme'];
const LEGACY=['animate_banner','hud_position','language','model','provider','theme'];
// core_session: the last private Core data directory (a path, never a credential) so `damar resume <id>` needs no flags.
const CORE_SESSION=v=>typeof v==='string'&&v.length<=260&&path.isAbsolute(v)&&!/["\r\n]/.test(v);
const LANGUAGES=['id','en'];
const DEFAULTS=Object.freeze({theme:'damar-ember',animate_banner:true,language:'en',hud_position:'left'});
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_UI_SETTINGS');
 const keys=Object.keys(value);
 if(keys.some(k=>!KEYS.includes(k))||value.schema!==1)throw Error('INVALID_UI_SETTINGS');
 if('theme' in value&&!themes.includes(value.theme)||'animate_banner' in value&&typeof value.animate_banner!=='boolean')throw Error('INVALID_UI_SETTINGS');
 if('language' in value&&!LANGUAGES.includes(value.language))throw Error('INVALID_UI_SETTINGS');
 if('hud_position' in value&&!['left','right','bottom','hidden'].includes(value.hud_position))throw Error('INVALID_UI_SETTINGS');
 if('core_session' in value&&!CORE_SESSION(value.core_session))throw Error('INVALID_UI_SETTINGS');
 if(('provider' in value)!==('model' in value)||'provider' in value&&(!PROVIDER.test(value.provider)||!MODEL.test(value.model)))throw Error('INVALID_UI_SETTINGS');
 return value;
}
// Core `cli` shape <-> CLI profile shape.
const fromCore=c=>({theme:c.theme,animate_banner:c.animateBanner,language:c.language,hud_position:c.hudPosition});
const toCore=({theme,bannerMode,language,hudPosition})=>Object.fromEntries(Object.entries({theme,animateBanner:bannerMode===undefined?undefined:bannerMode!=='static',language,hudPosition}).filter(([,v])=>v!==undefined));
class UISettings{
 // core (optional): {read:async()=>GET /api/r9/cli/settings data, write:async cli=>Core cli, canWrite:()=>bool}
 constructor(directory,{core=null}={}){if(!path.isAbsolute(directory))throw Error('ABSOLUTE_SESSION_REQUIRED');this.file=path.join(directory,'cli-ui-settings.json');this.core=core;this.known=null;this.offline=true;this.legacySelection=null;}
 local(){try{return validate(JSON.parse(fs.readFileSync(this.file,'utf8')));}catch(error){if(error.code==='ENOENT')return {schema:1};throw Error('INVALID_UI_SETTINGS');}}
 writeLocal(value){
  validate(value);fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,this.file);}
  catch{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch{}throw Error('UI_SETTINGS_SAVE_FAILED');}
  return value;
 }
 // Effective values: Core's (last known) > a not-yet-imported legacy profile > defaults; plus the local core_session.
 load(){
  const l=this.local(),legacy=Object.fromEntries(Object.entries(l).filter(([k,v])=>k!=='provider'&&k!=='model'&&LEGACY.includes(k)&&!(k==='language'&&v==='id')));
  const appearance=this.known?.cli?fromCore(this.known.cli):{...DEFAULTS,...legacy};
  const sel=this.known?.lastSelection||(l.provider?{provider:l.provider,model:l.model}:this.legacySelection);
  return {schema:1,...appearance,...(l.core_session?{core_session:l.core_session}:{}),...(sel?{provider:sel.provider,model:sel.model}:{})};
 }
 // Read Core; import a legacy local profile once when Core has no cli values yet. Never throws: offline is a state.
 async sync(){
  if(!this.core)return this.load();
  let data;try{data=await this.core.read();this.offline=false;}catch{this.offline=true;return this.load();}
  const l=this.local(),legacy=LEGACY.filter(k=>k in l);
  if(legacy.length&&!data.cli&&this.core.canWrite?.()){
   // Old CLI builds wrote language:'id' into every profile (it was the default, not a choice): a fresh DAMAR starts in English, so 'id' is not imported.
   const cli=toCore({theme:l.theme,bannerMode:l.animate_banner===undefined?undefined:l.animate_banner?'flame':'static',language:l.language==='en'?'en':undefined,hudPosition:l.hud_position});
   try{data={...data,cli:await this.core.write(cli)};}catch{this.known=data;return this.load();}
  }
  if(legacy.length&&data.cli){
   if(l.provider&&!data.lastSelection)this.legacySelection={provider:l.provider,model:l.model};
   this.writeLocal({schema:1,...(l.core_session?{core_session:l.core_session}:{})});  // migrated: stop keeping a local copy
  }
  this.known=data;return this.load();
 }
 // coreSession: local pointer (sync). Appearance: Owner write to Core (Promise); refused while offline.
 // Provider/model are never stored here: Core records the selection accepted by /api/r9/provider.
 save({theme,bannerMode,language,hudPosition,coreSession}={}){
  if(coreSession!==undefined){const l=this.local();this.writeLocal({...l,core_session:coreSession});}
  const cli=toCore({theme,bannerMode,language,hudPosition});
  if(!Object.keys(cli).length)return this.load();
  if(!this.core||this.offline||!this.core.canWrite?.())return Promise.reject(Error('CORE_SETTINGS_OFFLINE_READ_ONLY'));
  return this.core.write(cli).then(saved=>{this.known={...(this.known||{}),cli:saved};return this.load();});
 }
}
module.exports={UISettings,validate,DEFAULTS};
