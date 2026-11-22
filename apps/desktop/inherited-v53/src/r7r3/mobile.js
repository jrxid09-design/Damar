'use strict';
(() => {
  const set=(id,text)=>{const el=document.getElementById(id);if(el)el.textContent=text;};
   const notice=text=>{set('mobileRespText',text);set('mobileLiveResult',text);};
   let snapshot=null, refreshing=false, lastCommand='status';
   let preferences={theme:'dark',auto:false};
   try{const saved=JSON.parse(localStorage.getItem('damar.mobile.preferences'));if(saved&&['dark','light'].includes(saved.theme))preferences={theme:saved.theme,auto:saved.auto===true};}catch{}
   async function refresh(command=lastCommand){
     if(refreshing)return;refreshing=true;lastCommand=command;notice('LOADING · Reading local '+command+'…');document.getElementById('mobileRefresh').disabled=true;document.querySelector('.mobile-send-btn').disabled=true;document.getElementById('mobilePromptInput').setAttribute('aria-busy','true');
     try{
       const response=await fetch('/api/r7r3/overview',{signal:AbortSignal.timeout(3000),cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);snapshot=await response.json();
        set('meshPillText','Local browser preview · open Control');
        const jobs=document.getElementById('mobileLiveJobs');
        if(jobs){const rows=[...new Map([...snapshot.pendingPlans,...snapshot.jobs,...snapshot.failures].map(row=>[row.planId,row])).values()];jobs.replaceChildren(...rows.map(row=>{const item=document.createElement('li');item.textContent=row.status+' · '+row.planId;return item;}));if(!rows.length){const item=document.createElement('li');item.textContent='No local plans or jobs.';jobs.append(item);}}
       if(command==='jobs'){
         const rows=[...new Map([...snapshot.pendingPlans,...snapshot.jobs,...snapshot.failures].map(row=>[row.planId,row])).values()];
         notice(rows.length?'LIVE_LOCAL_SERVICE · '+rows.map(row=>row.status+' · '+row.planId).join('\n'):'EMPTY · No local plans or jobs. Create a bounded job in Control.');
       }else if(command==='runtime')notice('LIVE_LOCAL_SERVICE · Werkudara '+(snapshot.supervisor.enabled?'ON':'OFF')+' · '+snapshot.supervisor.mode+'\n'+snapshot.provider.reason+'\n'+snapshot.deviceBridge.reason);
        else notice(`LIVE_LOCAL_SERVICE: ${snapshot.jobs.length} jobs; Werkudara ${snapshot.supervisor.enabled?'ON':'OFF'}. No phone transport paired. Read ${new Date().toLocaleTimeString()} from /api/r7r3/overview.`);
      }catch(error){snapshot=null;set('mobileLiveJobs','OFFLINE · Job state unavailable. Refresh to retry.');notice('OFFLINE · Local service unavailable ('+error.message+'). Refresh or submit status to retry. No command executed.');}
     finally{refreshing=false;document.getElementById('mobileRefresh').disabled=false;document.querySelector('.mobile-send-btn').disabled=false;document.getElementById('mobilePromptInput').removeAttribute('aria-busy');}
   }
   window.runMobileCommand=command=>{if(refreshing){notice('LOADING · Wait for the current '+lastCommand+' readback before sending another command.');return;}const value=String(command).trim().toLowerCase();if(/^(status|jobs|runtime)$/.test(value))void refresh(value);else notice(value?'Command unavailable. Supported local preview commands: status, jobs, runtime. No model or device action executed.':'Enter status, jobs or runtime. No command sent.');};
   window.submitMobilePrompt=()=>{if(refreshing)return;const input=document.getElementById('mobilePromptInput');window.runMobileCommand(input.value);input.value='';try{sessionStorage.removeItem('damar.mobile.command-draft');}catch{}};
  window.toggleEdithCamera=()=>notice('Camera unavailable: no paired device transport or camera permission configured.');
  window.decideMobileApproval=()=>notice('Approval unavailable in Mobile preview. Use the separate owner CLI workflow.');
  window.startMobilePhoneUse=()=>notice('Phone automation unavailable: no authenticated paired transport.');
  window.handoffToPcWorkstation=()=>location.assign('/cc2');
  window.mobileWinCtrl=()=>notice('Native window controls unavailable in browser preview.');
  window.triggerMobileVoice=()=>notice('Voice unavailable: microphone transport is not configured. Type status, jobs or runtime.');
  window.triggerAodVoiceTest=()=>notice('Voice test unavailable: no microphone requested.');
  window.stopMobilePhoneUse=()=>notice('No phone automation is running; paired transport is unavailable.');
  window.inspectMobileModule=()=>notice('Module unavailable in this local preview. No live module data or action is claimed.');
   document.querySelectorAll('[onclick]:not(button):not(input)').forEach(el=>{
    el.setAttribute('role','button');el.tabIndex=0;el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();el.click();}});
  });
  document.querySelectorAll('[onclick*="inspectMobileModule"]').forEach(el=>{el.replaceChildren();el.textContent='Module unavailable in local preview. Open Control for live jobs and supervisor status.';});
  const status=document.createElement('p');status.id='mobileCapabilityNotice';status.setAttribute('role','status');status.textContent='LOCAL PREVIEW · camera, voice, device automation and approvals unavailable. No authenticated phone transport.';
    document.getElementById('phoneChassis').prepend(status);
    const skip=document.createElement('a');skip.href='#mobilePromptInput';skip.textContent='Skip to local command';skip.className='mobile-skip';document.body.prepend(skip);skip.onclick=()=>document.getElementById('mobilePromptInput').focus();
   const settings=document.createElement('section');settings.id='mobilePreferences';settings.setAttribute('aria-label','Local Mobile preferences');
   settings.innerHTML='<button id="mobileRefresh" type="button">Refresh local data</button><details><summary>Local preferences</summary><form id="mobilePreferencesForm"><label>Theme <select id="mobileTheme"><option value="dark">Dark</option><option value="light">Light</option></select></label><label><input id="mobileAuto" type="checkbox"> Refresh local data every 5 seconds</label><button type="submit">Save Mobile preferences</button><p id="mobilePreferenceResult" role="status"></p></form></details>';
   status.after(settings);
   const liveResult=document.createElement('p');liveResult.id='mobileLiveResult';liveResult.setAttribute('role','status');settings.after(liveResult);
   const panel=(id,html)=>{document.getElementById(id).innerHTML=html;};
   panel('pane-edith','<h2>Device sensors</h2><p>UNAVAILABLE · No authenticated phone transport, camera or sensor source is connected. No room activity or sensor confidence is measured.</p><button type="button" disabled>Camera unavailable</button><button type="button" id="mobileSensorStatus">Read device availability</button><button type="button" id="mobileSensorBack">Return to Presence</button>');
   panel('pane-phoneuse','<h2>Phone automation</h2><p>UNAVAILABLE · No paired transport. No automation is running and no device checkpoint exists in this preview.</p><button type="button" disabled>Start unavailable</button><button type="button" disabled>Stop unavailable</button><button type="button" id="mobileDeviceStatus">Read device availability</button><button type="button" id="mobileDeviceControl">Open local Control</button>');
   panel('pane-matrix','<h2>Local jobs and authority</h2><p>Read-only projection of the active DAMAR runtime. Approval and revocation require separate owner credentials in Control or CLI. No synthetic approval request is shown.</p><button type="button" id="mobileJobsRefresh">Refresh local jobs</button><ul id="mobileLiveJobs"><li>Loading local jobs…</li></ul><button type="button" id="mobileJobsControl">Open owner workflow in Control</button><h3>Other modules</h3><p>Security telemetry, finance, memory synchronization and developer bridge actions are unavailable in this preview. No module activity is claimed.</p>');
   for(const id of ['mobileSensorStatus','mobileDeviceStatus'])document.getElementById(id).onclick=()=>void refresh('runtime');
   document.getElementById('mobileSensorBack').onclick=()=>window.switchMobileTab('presence');
   document.getElementById('mobileJobsRefresh').onclick=()=>void refresh('jobs');
   for(const id of ['mobileDeviceControl','mobileJobsControl'])document.getElementById(id).onclick=()=>window.handoffToPcWorkstation();
   const style=document.createElement('style');style.textContent='#mobilePreferences,#mobileCapabilityNotice{position:relative;z-index:25;margin:8px;padding:8px;background:#161616;color:#f1eadb;font:14px system-ui}#mobilePreferences button,#mobilePreferences select,#mobilePreferences summary{min-height:44px;padding:8px}#mobilePreferences label{display:block;margin:8px}#mobileRespText{white-space:pre-wrap;overflow-wrap:anywhere}body[data-mobile-theme="light"] .phone-chassis{background:#f5f0e5;color:#211b11}body[data-mobile-theme="light"] .sovereign-card,body[data-mobile-theme="light"] .mobile-response-card,body[data-mobile-theme="light"] .mobile-input-bar{background:#fff8eb;color:#211b11}body[data-mobile-theme="light"] .phone-chassis p,body[data-mobile-theme="light"] .phone-chassis h1,body[data-mobile-theme="light"] .phone-chassis h2,body[data-mobile-theme="light"] .phone-chassis h3{color:inherit} :focus-visible{outline:3px solid #d6aa58!important;outline-offset:3px}';document.head.append(style);
   style.textContent+='#phoneChassis{min-width:0}#mobileCapabilityNotice{flex-shrink:0;font-size:12px;margin:4px;padding:6px}#mobilePreferences{flex-shrink:0;margin:4px;padding:4px}#mobilePreferences details[open]{max-height:220px;overflow:auto}#mobilePreferences{display:flex;flex-wrap:wrap;gap:8px}#mobilePreferences details{flex:1}body[data-mobile-theme="light"] .phone-chassis{--gold:#76500c;--gold-light:#684300}body[data-mobile-theme="light"] .mobile-brand,body[data-mobile-theme="light"] .mobile-greeting,body[data-mobile-theme="light"] .nav-tab{color:#684300}';
   style.textContent+='#mobileCapabilityNotice{margin-top:32px}body[data-mobile-theme="light"] .view-pane,body[data-mobile-theme="light"] .view-pane *{color:#49330d!important;text-shadow:none!important}body[data-mobile-theme="light"] .view-pane .sovereign-card{border-color:#9b7a3e}body[data-mobile-theme="light"] #mobileRespText{color:#211b11!important}';
   style.textContent+='#mobileLiveResult{flex-shrink:0;max-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px;padding:8px;background:#181818;color:#f1eadb;font:13px system-ui}.view-pane h2{font-size:18px}.view-pane button{min-height:44px;margin:4px}.view-pane ul{padding-left:20px;overflow-wrap:anywhere}';
   style.textContent+='@media(max-width:450px){#phoneChassis{height:100dvh;max-height:100dvh}.mobile-brand{min-width:0}.surface-mesh-pill{min-width:0;max-width:48%}#mobileLiveResult{max-height:72px}#mobileCapabilityNotice{font-size:11px}}.view-pane{min-height:0;overflow:auto}';
   const apply=()=>{document.body.dataset.mobileTheme=preferences.theme;document.getElementById('mobileTheme').value=preferences.theme;document.getElementById('mobileAuto').checked=preferences.auto;};apply();
   document.getElementById('mobileRefresh').onclick=()=>void refresh();
   document.getElementById('mobilePreferencesForm').onsubmit=event=>{event.preventDefault();const next={theme:document.getElementById('mobileTheme').value,auto:document.getElementById('mobileAuto').checked};try{localStorage.setItem('damar.mobile.preferences',JSON.stringify(next));preferences=next;apply();set('mobilePreferenceResult','Preferences saved on this browser.');}catch{set('mobilePreferenceResult','Storage unavailable. Preferences were not saved.');}};
   const originalSwitch=window.switchMobileTab;
    window.switchMobileTab=tab=>{if(!['presence','edith','phoneuse','matrix'].includes(tab))return;originalSwitch(tab);document.querySelectorAll('.nav-tab').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tab===tab)));try{sessionStorage.setItem('damar.mobile.pane',tab);}catch{}};
    try{const tab=sessionStorage.getItem('damar.mobile.pane');if(tab)window.switchMobileTab(tab);}catch{}
   document.querySelectorAll('.nav-tab').forEach(el=>{el.setAttribute('aria-pressed',String(el.classList.contains('active')));el.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('.nav-tab')],index=tabs.indexOf(el),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();});});
   document.getElementById('mobilePromptInput').setAttribute('aria-label','Local command: status, jobs or runtime');
    document.getElementById('mobilePromptInput').placeholder='Local command: status, jobs or runtime';
    const prompt=document.getElementById('mobilePromptInput');
    try{prompt.value=sessionStorage.getItem('damar.mobile.command-draft')||'';}catch{}
    prompt.addEventListener('input',()=>{try{sessionStorage.setItem('damar.mobile.command-draft',prompt.value);}catch{}});
   document.querySelectorAll('.deck-card-inner').forEach(el=>{const action=el.getAttribute('onclick')||'';if(action.includes('runMobileCommand')){el.setAttribute('onclick',"runMobileCommand('status')");el.textContent='Local status · read runtime';}else if(action.includes('startMobilePhoneUse'))el.textContent='Phone automation unavailable · no paired transport';else if(action.includes("switchMobileTab('matrix')"))el.textContent='Modules and approvals · unavailable in Mobile preview';else if(action.includes('handoffToPcWorkstation'))el.textContent='Open Control · local jobs and owner workflow';});
   document.querySelector('.mobile-send-btn')?.setAttribute('aria-label','Send local command');
   document.querySelectorAll('[onclick*="mobileWinCtrl"],[onclick*="triggerMobileVoice"],[onclick*="triggerAodVoiceTest"]').forEach(el=>{
     el.removeAttribute('onclick');el.setAttribute('aria-disabled','true');el.setAttribute('title','Unavailable in local preview: no native device transport');
     if(el.tagName==='BUTTON')el.disabled=true;else{el.removeAttribute('role');el.tabIndex=-1;}
   });
   // A status animation is not a command or a device control.
   const orb=document.getElementById('mobileOrbSanctuary');orb.removeAttribute('onclick');orb.removeAttribute('role');orb.removeAttribute('tabindex');
   document.querySelectorAll('[aria-disabled="true"]').forEach(el=>{el.style.cursor='not-allowed';});
    style.textContent+='@media(max-width:375px){.mobile-greeting{font-size:18px}.deck-card-inner{font-size:13px;padding:10px}.mobile-response-card{min-height:110px}.view-pane{padding-bottom:16px}}#mobileLiveResult{line-height:1.4}';
    style.textContent+='.mobile-skip{position:fixed;left:8px;top:-100px;z-index:9999;background:#fff8eb;color:#49330d;padding:12px}.mobile-skip:focus{top:8px}body[data-mobile-theme="light"] :focus-visible{outline-color:#684300!important}#mobilePreferences :focus-visible{outline-color:#f3dfb3!important}';
   style.textContent+='body[data-mobile-theme="light"] .phone-chassis{--text-ivory:#32250f;--text-muted:#594b34;--text-dim:#635135;--gold-bright:#684300;--gold-champagne:#76500c}body[data-mobile-theme="light"] .mobile-greeting,body[data-mobile-theme="light"] .greeting-title{color:#684300!important}body[data-mobile-theme="light"] .nav-tab{color:#f2d48b}body[data-mobile-theme="light"] input{background:#171717;color:#fff0d0}#mobilePreferences input,#mobilePromptInput{user-select:text}.view-pane button{font:inherit;padding:10px;border:1px solid #9b7a3e;border-radius:6px;background:#191715;color:#f3dfb3}.view-pane button:disabled{color:#c6bca9;border-color:#81745c;cursor:not-allowed}body[data-mobile-theme="light"] .view-pane button{background:#fff8eb;color:#49330d!important}body[data-mobile-theme="light"] .view-pane button:disabled{background:#eee8dc;color:#655944!important}';
   document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('aod-standby-active')){window.toggleAodStandbyMode();document.getElementById('dynamicIsland').focus();}});
   setInterval(()=>{if(preferences.auto&&!document.hidden&&!refreshing)void refresh();},5000);
  document.querySelectorAll('[onclick*="decideMobileApproval"],[onclick*="toggleEdithCamera"],[onclick*="startMobilePhoneUse"]').forEach(el=>{el.disabled=true;el.title='Unavailable: no authenticated paired device transport';el.setAttribute('aria-disabled','true');});
   set('mobileTraceSteps','Local browser preview; PHYSICAL_NOT_RUN');set('mobileRespTimer','No model calls');
   document.querySelectorAll('.phone-chassis span').forEach(el=>{if(el.textContent.includes('5G')&&el.textContent.includes('98%'))el.textContent='Phone telemetry unavailable';});
   document.querySelectorAll('.phone-chassis span').forEach(el=>{if(el.children.length===0&&el.textContent.trim().toUpperCase()==='DAMAR NOTCH')el.textContent='DAMAR';});
   style.textContent+='#mobilePromptInput::placeholder{color:#c6bca9;opacity:1}';
  void refresh();
})();
