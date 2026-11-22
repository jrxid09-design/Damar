'use strict';
const themes=Object.freeze(['damar-ember','damar-holo','cyberpunk','tokyonight','emerald']);
const legacyThemes=Object.freeze(['codex-dark']);
const definitions=Object.freeze({settings:'settings',themes:'themes [original-theme]',banner:'banner [flame|static]',sidebar:'sidebar [on|off]',details:'details',language:'language [id|en]'});
const aliases=Object.freeze({theme:'themes',expand:'details',bahasa:'language'});
// Settings Control Center: the Owner prototype's six-card form (settings-center.cjs). Its Core-backed fields use the
// dependencies main.cjs injects (tui.settingsDeps); without a Core session those fields stay disabled with the reason.
function openSettings(tui){
 const {SettingsCenter}=require('./settings-center.cjs');
 const deps={close:message=>{tui.settingsCenter=null;if(message)tui.notice=message;tui.render();},run:line=>tui.emit('line',line),...(tui.settingsDeps||{})};
 tui.pick=null;tui.settingsCenter=new SettingsCenter(tui,deps);
 tui.settingsCenter.load();
 return tui.settingsCenter;
}
function parseAppearance(line){
 const parts=line.trim().replace(/^\//,'').split(/\s+/),name=aliases[parts[0]]||parts[0];
 if(!Object.hasOwn(definitions,name))return null;
  const args=parts.slice(1);if(args.length>1)throw Error('UNEXPECTED_ARGUMENT');
  const value=args[0];
  if(name==='settings'&&value)throw Error('UNEXPECTED_ARGUMENT');
  if(name==='themes'&&value&&!themes.includes(value)&&!legacyThemes.includes(value))throw Error('UNKNOWN_ORIGINAL_THEME');
 if(name==='banner'&&value&&!['flame','static'].includes(value))throw Error('INVALID_BANNER_MODE');
 if(name==='sidebar'&&value&&!['on','off'].includes(value))throw Error('INVALID_SIDEBAR_MODE');
 if(name==='details'&&value)throw Error('UNEXPECTED_ARGUMENT');
 if(name==='language'&&value&&!['id','en'].includes(value))throw Error('INVALID_LANGUAGE');
 return {name,value};
}
function applyAppearance(tui,{name,value}){
  if(name==='settings'){const center=openSettings(tui);tui.render();return {state:'OPENED_NATIVE_SETTINGS',cards:center.view().cards};}
 if(name==='themes'){
  if(value)tui.theme=value;
  else tui.pick={kind:'theme',choices:[...themes],index:Math.max(0,themes.indexOf(tui.theme))};
 }else if(name==='banner')tui.bannerMode=value||(tui.bannerMode==='static'?'flame':'static');
 else if(name==='sidebar')tui.sidebarEnabled=value?value==='on':tui.sidebarEnabled===false;
 else if(name==='details')tui.details=!tui.details;
 else if(name==='language')tui.language=value||(tui.language==='en'?'id':'en');
 else throw Error('UNKNOWN_APPEARANCE_COMMAND');
 const persisted=['themes','banner','language'].includes(name)&&!(name==='themes'&&!value);
 if(persisted)tui.persistAppearance?.();
 tui.render();
 return {state:tui.settings&&persisted?'APPLIED_PRIVATE_SESSION_PROFILE':'APPLIED_SESSION_ONLY',command:name,theme:tui.theme||'damar-ember',banner:tui.bannerMode||'flame',sidebar:tui.sidebarEnabled!==false,details:!!tui.details,language:tui.language==='id'?'id':'en'};
}
module.exports={themes,legacyThemes,definitions,aliases,parseAppearance,applyAppearance,openSettings};
