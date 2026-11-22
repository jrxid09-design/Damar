'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let snapshot=null, busy=false, online=false, selectedJob=null, jobBusy=false, planUncertain=false;
  const requestIds=new Map();
  try{planUncertain=sessionStorage.getItem('damar.plan-uncertain')==='true';}catch{}
  $('job-uncertain').hidden=!planUncertain;$('plan-submit').disabled=planUncertain;
  const uncertainActions=new Map();
  try{const rows=JSON.parse(sessionStorage.getItem('damar.uncertain-actions')||'[]');for(const [id,value]of rows)if(typeof id==='string'&&value&&['approve','execute','cancel','revoke','verify'].includes(value.action))uncertainActions.set(id,value);}catch{}
  function saveUncertain(){for(const value of uncertainActions.values())if(!value.operationId)value.operationId=crypto.randomUUID();try{sessionStorage.setItem('damar.uncertain-actions',JSON.stringify([...uncertainActions]));}catch{}renderUncertain();}
  function rememberAction(planId,value){const prior=uncertainActions.get(planId);uncertainActions.set(planId,{...value,operationId:prior?.operationId||crypto.randomUUID(),at:prior?.at||value.at});saveUncertain();}
  function renderUncertain(){
    $('uncertain-list').replaceChildren(...[...uncertainActions].map(([planId,value])=>{const li=document.createElement('li');li.textContent=value.action+' · '+planId+' · version '+value.version+' · operation '+(value.operationId||'legacy reference')+' · '+value.at+' ';const button=document.createElement('button');button.type='button';button.textContent='Read current state';button.onclick=()=>{dialogOrigin=null;openJob({planId,version:value.version,status:'OUTCOME_UNKNOWN'},value.action);};li.append(button);return li;}));
    if(!uncertainActions.size){const li=document.createElement('li');li.textContent='No unconfirmed action recorded in this browser session.';$('uncertain-list').append(li);}
  }
  renderUncertain();
  let dialogOrigin=null;
  let refreshController=null, refreshSequence=0;
  let planReadbackChecked=false;
  let actionReadback=null, actionReadSequence=0;
  $('job-reconcile-action').after($('job-acknowledge-action'));
  function invalidateActionReadback(){actionReadback=null;actionReadSequence++;$('job-acknowledge-action').disabled=true;}
  $('job-acknowledge').disabled=true;
  try{$('job-text').value=sessionStorage.getItem('damar.plan-draft')||'';}catch{}
  $('job-text').addEventListener('input',()=>{try{sessionStorage.setItem('damar.plan-draft',$('job-text').value);}catch{}});
  let preferences={theme:'dark',auto:false};
  try { const value=JSON.parse(localStorage.getItem('damar.control.preferences')); if(value && ['dark','light'].includes(value.theme)) preferences={theme:value.theme,auto:value.auto===true}; } catch {}
  function apply(){document.documentElement.dataset.theme=preferences.theme;$('theme').value=preferences.theme;$('auto').checked=preferences.auto;}
  apply();
  const presence=document.querySelector('header a');
  presence.addEventListener('click',event=>{
    if(window.damarDesktop?.navigateSurface){event.preventDefault();void window.damarDesktop.navigateSurface('presence');}
  });
  const list=(id,values,empty)=>{const nodes=values.map(value=>{const li=document.createElement('li');li.textContent=value;return li;});if(!nodes.length){const li=document.createElement('li');li.textContent=empty;nodes.push(li);}$(id).replaceChildren(...nodes);};
  function mode(){const only=$('mode').value==='EVENT_ONLY';$('calls').disabled=only;$('spend').disabled=only;$('enable').textContent=only?'Enable event-only':'Enable event review';$('enable').disabled=busy||!online||(!only&&!snapshot?.supervisor.providerAvailable);$('disable').disabled=busy||!online;}
  function jobs(){if(!snapshot)return;const focused=document.activeElement;const focusBinding=$('job-list').contains(focused)?{planId:focused.closest('li')?.dataset.planId,action:focused.dataset.action}:null;let rows=[...snapshot.pendingPlans,...snapshot.jobs,...snapshot.failures];rows=[...new Map(rows.map(row=>[row.planId,row])).values()];const q=$('search').value.toLowerCase(), status=$('status').value;rows=rows.filter(row=>(!status||row.status===status)&&JSON.stringify(row).toLowerCase().includes(q));rows.sort((a,b)=>a.expiresAt-b.expiresAt||a.planId.localeCompare(b.planId));if($('sort').value==='newest')rows.reverse();$('count').textContent=`${rows.length} matching plans/jobs`;list('job-list',rows.map(row=>`${row.status} · ${row.planId} · version ${row.version}${row.result?' · SHA-256 '+row.result.sha256:''}`),'No matching plans or jobs. Clear filters or create a bounded job with DAMAR CLI.');
    rows.forEach((row,index)=>{const li=$('job-list').children[index];li.dataset.planId=row.planId;const actions=row.status==='PLANNED'?['approve','execute','cancel','revoke']:row.status==='QUEUED'?['cancel','revoke']:row.status==='VERIFIED'?['verify']:[];
      for(const action of actions){const button=document.createElement('button');button.textContent=action[0].toUpperCase()+action.slice(1);button.type='button';button.dataset.action=action;button.onclick=()=>{dialogOrigin={planId:row.planId,action};openJob(row,action);};li.append(button);}});
    if(focusBinding){const row=[...$('job-list').children].find(el=>el.dataset.planId===focusBinding.planId);const target=row&&[...row.querySelectorAll('button')].find(el=>el.dataset.action===focusBinding.action);(target||$('refresh')).focus();}
    }
  function openJob(row,action){selectedJob={row,action};$('job-command-title').textContent=action+' SHA-256 job';$('job-binding').textContent=row.planId+' · version '+row.version+' · '+row.status;$('job-key-label').firstChild.textContent=['approve','revoke'].includes(action)?'Separate owner credential':'Requester credential';$('job-key').value='';$('approval-id').value='';$('approval-label').hidden=action!=='execute';$('approval-id').required=action==='execute';const uncertain=uncertainActions.has(row.planId);$('job-command-result').textContent=uncertain?'Prior action outcome unknown. Enter a credential and read current state before another mutation.':'';$('job-confirm').disabled=uncertain;$('job-reconcile-action').hidden=!uncertain;$('job-dialog').showModal();$('job-key').focus();}
  async function jobRequest(action,body,key){
    const mutation=action!=='reconcile';
    if(mutation){if(action==='plan'){planUncertain=true;try{sessionStorage.setItem('damar.plan-uncertain','true');sessionStorage.setItem('damar.plan-operation',JSON.stringify({operationId:crypto.randomUUID(),action:'plan',at:new Date().toISOString()}));}catch{}}else{rememberAction(body.planId,{action,version:body.version,at:new Date().toISOString()});}}
    let response;try{response=await fetch('/api/r7r3/jobs/'+action,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});}catch{throw Object.assign(Error('Outcome unknown: request interrupted. Refresh and reconcile; do not assume failure or repeat the action.'),{uncertain:true});}
    let value;try{value=await response.json();}catch{throw Object.assign(Error('Outcome unknown: invalid service response. Refresh and reconcile.'),{uncertain:true});}
    if(!value||typeof value!=='object'||(response.ok?(value.success!==true||!value.data||typeof value.data!=='object'):(value.success!==false||!value.error)))throw Object.assign(Error('Outcome unknown: unrecognized service acknowledgement. Read current state; no automatic retry.'),{uncertain:true});
    if(mutation){if(action==='plan'){planUncertain=false;try{sessionStorage.removeItem('damar.plan-uncertain');sessionStorage.removeItem('damar.plan-operation');}catch{}}else{uncertainActions.delete(body.planId);saveUncertain();}}
    if(!response.ok)throw Error(value.error?.code||value.error||'Job rejected');return value.data;
  }
  $('job-cancel-dialog').onclick=()=>{if(!jobBusy)$('job-dialog').close();};
  $('job-dialog').addEventListener('cancel',event=>{if(jobBusy){event.preventDefault();$('job-command-result').textContent='Waiting for service outcome. Closing is temporarily disabled; no second action will be sent.';}});
  $('job-dialog').setAttribute('aria-labelledby','job-command-title');
  $('job-dialog').setAttribute('aria-describedby','job-binding');
  $('job-dialog').addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const items=[...$('job-dialog').querySelectorAll('input,button,select,textarea,[tabindex]')].filter(el=>!el.disabled&&el.getClientRects().length&&el.tabIndex>=0);
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  $('job-dialog').addEventListener('close',()=>{
    invalidateActionReadback();$('job-acknowledge-action').hidden=true;
    $('job-key').value='';$('approval-id').value='';
    const row=[...$('job-list').children].find(el=>el.dataset.planId===dialogOrigin?.planId);
    const origin=row&&[...row.querySelectorAll('button')].find(el=>el.dataset.action===dialogOrigin?.action);
    // Refresh replaces the row buttons while the modal is open.
    (origin||$('refresh')).focus();
  });
  window.addEventListener('beforeunload',event=>{if(jobBusy){event.preventDefault();event.returnValue='';}});
  $('job-command').onsubmit=async event=>{event.preventDefault();if(jobBusy||!selectedJob||uncertainActions.has(selectedJob.row.planId))return;jobBusy=true;$('job-confirm').disabled=true;const{row,action}=selectedJob;const key=$('job-key').value;$('job-key').value='';try{const body={planId:row.planId,version:row.version};if(action==='execute'){body.approvalId=$('approval-id').value;body.requestId=requestIds.get(row.planId)||crypto.randomUUID();requestIds.set(row.planId,body.requestId);}$('approval-id').value='';const result=await jobRequest(action,body,key);$('job-command-result').textContent=action==='approve'?'Owner approved. Copy this grant for separate requester execution: '+result.approvalId:'Service confirmed '+action+': '+(result.status||JSON.stringify(result));await refresh();}catch(error){if(error.uncertain){rememberAction(row.planId,{action,version:row.version,at:new Date().toISOString()});$('job-reconcile-action').hidden=false;}$('job-command-result').textContent='Not confirmed: '+error.message;}finally{jobBusy=false;$('job-confirm').disabled=uncertainActions.has(row.planId);}};
  $('job-reconcile-action').onclick=async()=>{if(jobBusy||!selectedJob)return;const binding=selectedJob,{row,action}=binding;const key=$('job-key').value;$('job-key').value='';if(!key){$('job-command-result').textContent='Enter owner or requester credential to read current state.';return;}invalidateActionReadback();const sequence=actionReadSequence;jobBusy=true;try{const state=await jobRequest('reconcile',{},key);if(sequence!==actionReadSequence||selectedJob!==binding)return;const plan=state.plans.find(p=>p.planId===row.planId&&p.version===row.version);if(!plan)throw Error('Matching job and version absent; unresolved action retained.');const approval=state.approvals.find(a=>a.planId===row.planId);$('job-command-result').textContent='Readback: '+plan.status+'; approval '+(!approval?'absent':approval.revoked?'revoked':approval.expired?'expired':'active')+'. Operation '+action+' · '+row.planId+' · version '+row.version+' · '+new Date().toISOString()+'. Review and acknowledge this exact readback. No retry sent. '+(approval&&!approval.revoked&&!approval.expired?'A lost grant cannot be recovered here; revoke before approving again.':'');actionReadback={binding,sequence};$('job-acknowledge-action').hidden=false;$('job-acknowledge-action').disabled=false;}catch(error){$('job-command-result').textContent='Reconciliation not confirmed: '+error.message;}finally{jobBusy=false;}};
  $('job-acknowledge-action').onclick=()=>{if(!actionReadback||actionReadback.binding!==selectedJob||actionReadback.sequence!==actionReadSequence||jobBusy)return;uncertainActions.delete(selectedJob.row.planId);saveUncertain();invalidateActionReadback();$('job-acknowledge-action').hidden=true;$('job-reconcile-action').hidden=true;$('job-command-result').textContent+=' Acknowledged. Close and choose a deliberate next action.';};
  $('job-acknowledge').addEventListener('click',()=>{if(!planUncertain)try{sessionStorage.removeItem('damar.plan-operation');}catch{}});
  $('plan-form').onsubmit=async event=>{event.preventDefault();if(jobBusy||planUncertain)return;const text=$('job-text').value;if(!text.trim()){$('job-action').textContent='Enter nonempty synthetic text.';$('job-text').focus();return;}if(new TextEncoder().encode(text).length>4096){$('job-action').textContent='Text exceeds 4096 UTF-8 bytes.';return;}jobBusy=true;$('plan-submit').disabled=true;const key=$('requester').value;$('requester').value='';try{const row=await jobRequest('plan',{text,syntheticData:true},key);$('job-action').textContent='Service created plan '+row.planId;await refresh();}catch(error){if(error.uncertain){planUncertain=true;try{sessionStorage.setItem('damar.plan-uncertain','true');}catch{}$('job-uncertain').hidden=false;}$('job-action').textContent='Not confirmed: '+error.message;}finally{jobBusy=false;$('plan-submit').disabled=planUncertain;}};
  $('job-reconcile').onclick=async()=>{planReadbackChecked=false;$('job-acknowledge').disabled=true;const confirmed=await refresh();if(confirmed&&online){planReadbackChecked=true;$('job-acknowledge').disabled=false;$('job-action').textContent='Current job list read back. Review it before acknowledging a new request.';}};
  $('job-acknowledge').onclick=()=>{if(!online||!planReadbackChecked){$('job-action').textContent='Reconnect and reconcile jobs before issuing a new request.';return;}planUncertain=false;planReadbackChecked=false;try{sessionStorage.removeItem('damar.plan-uncertain');}catch{}$('job-uncertain').hidden=true;$('plan-submit').disabled=false;$('job-action').textContent='Reconciliation acknowledged. A new submission creates a new plan.';};
  let catalogGeneration=0,catalogController=null;
  $('discover-models').onclick=async()=>{
    const generation=++catalogGeneration;catalogController?.abort();const controller=new AbortController();catalogController=controller;const timeout=setTimeout(()=>controller.abort(),4000);
    const button=$('discover-models'), select=$('model-select');
    button.disabled=true;select.disabled=true;select.replaceChildren();
    $('model-saved').textContent='';$('model-status').textContent='LOADING · Reading gateway catalog…';
    try{
      const response=await fetch('/api/r7r3/models',{signal:controller.signal});
      if(!response.ok)throw Error('Catalog unavailable. Refresh the model catalog to retry.');
      const value=await response.json();
      if(generation!==catalogGeneration)return;
      if(!Array.isArray(value.models))throw Error('Unsupported catalog response.');
      value.models=[...new Set(value.models.filter(m=>m&&typeof m.id==='string'&&m.id===m.id.trim()&&m.id.length>0&&m.id.length<=256&&!/[\x00-\x1f\x7f]/.test(m.id)).map(m=>m.id))].map(id=>({id}));
      if(!value.available){
        $('model-status').textContent=value.state==='AUTHENTICATION_REQUIRED'
          ?'AUTHENTICATION_REQUIRED · Gateway requires approved credentials. Configure access outside DAMAR, then refresh. No credential was sent.'
          :(value.state==='TIMEOUT'?'TIMEOUT':'UNAVAILABLE')+' · '+(value.reason||'Gateway unavailable')+'. Refresh the model catalog to retry.';
        return;
      }
      for(const model of value.models){const option=document.createElement('option');option.value=model.id;option.textContent=model.id;select.append(option);}
      select.disabled=!value.models.length;
      $('model-status').textContent=value.models.length?value.models.length+' discovered models; no inference sent':'EMPTY · Gateway returned no models. Refresh after models become available.';
      let saved;try{saved=localStorage.getItem('damar.preferred-model');}catch{$('model-saved').textContent='Preference storage unavailable. Selection is temporary.';}
      if(value.models.some(m=>m.id===saved))select.value=saved;
      else if(saved){select.selectedIndex=-1;$('model-saved').textContent='Saved model is absent from this catalog. Choose an available model explicitly.';}
    }catch(error){if(generation!==catalogGeneration)return;select.replaceChildren();select.disabled=true;$('model-status').textContent=controller.signal.aborted?'TIMEOUT · Catalog did not respond within four seconds. Refresh to retry.':'UNAVAILABLE · '+error.message;}
    finally{clearTimeout(timeout);if(generation===catalogGeneration)button.disabled=false;}
  };
  $('model-select').onchange=()=>{try{localStorage.setItem('damar.preferred-model',$('model-select').value);$('model-saved').textContent='Local model preference saved. Inference remains disabled.';}catch{$('model-saved').textContent='Preference storage unavailable.';}};
  async function refresh(){
    invalidateActionReadback();
    if(planUncertain){planReadbackChecked=false;$('job-acknowledge').disabled=true;}
    const sequence=++refreshSequence;refreshController?.abort();const controller=new AbortController();refreshController=controller;
    const timeout=setTimeout(()=>controller.abort(),3000);$('connection').textContent=(online?'RECONNECTING':'CONNECTING')+' · Reading local runtime…';
    try{const response=await fetch('/api/r7r3/overview',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error(`HTTP ${response.status}`);const data=await response.json();if(sequence!==refreshSequence)return;snapshot=data;online=true;$('connection').textContent='Online · LIVE_LOCAL_SERVICE · '+new Date().toLocaleTimeString();const s=data.supervisor;$('supervisor').textContent=`${s.enabled?'ON':'OFF'} · ${s.mode} · ${s.monitoredJobs} monitored jobs`;$('provider').textContent=data.provider.reason;$('device').textContent=data.deviceBridge.reason;$('budget').textContent=JSON.stringify(s.budget,null,2);list('event-list',data.events.map(row=>`${row.sequence} · ${row.type} · ${row.taskId}`),'No local job events yet.');list('advisories',s.advisories.map(row=>JSON.stringify(row)),'No advisory recorded. No inference requested.');list('alerts',s.alerts.map(row=>JSON.stringify(row)),'No supervisor alerts.');jobs();
      $('dispatch-state').textContent=s.budget.inFlight?'RECONCILIATION REQUIRED · '+s.budget.inFlight+' dispatched review(s) retain conservative budget. No automatic replay or refund. Keep supervision OFF and ask the owner to inspect the isolated session ledger.':'No dispatched review is awaiting settlement. Last event: '+(s.lastTrigger?.decision||'none')+' · fencing epoch '+s.leaseEpoch;
      if(s.heldReviews?.length)$('dispatch-state').textContent+=' '+s.heldReviews.map(row=>'Reservation '+row.reservationId+' · event '+row.eventId+' · epoch '+row.epoch+' · created '+new Date(row.createdAt).toISOString()+' · held units '+row.maxSpendUnits).join('; ');
      return true;
    }catch(error){if(sequence!==refreshSequence)return false;online=false;$('connection').textContent='OFFLINE · Last displayed data may be stale. Retry with Refresh runtime. '+error.message;return false;}finally{clearTimeout(timeout);if(sequence===refreshSequence)mode();}
  }
  async function command(action){if(busy)return;const owner=$('owner').value;if(!owner){$('action').textContent='Enter the separate owner candidate credential. No action sent.';$('owner').focus();return;}$('owner').value='';busy=true;mode();$('action').textContent='Waiting for owner-authorized service readback…';try{const only=$('mode').value==='EVENT_ONLY';const body=action==='off'?{}:{mode:$('mode').value,maxCalls:only?0:Number($('calls').value),maxSpendUnits:only?0:Number($('spend').value)};const response=await fetch('/api/r7/supervisor/'+action,{method:'POST',headers:{authorization:'Bearer '+owner,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Action rejected');$('action').textContent=`Service confirmed ${result.data.enabled?'ON':'OFF'} · ${result.data.mode}`;await refresh();}catch(error){$('action').textContent='Not confirmed: '+error.message;}finally{busy=false;mode();}}
  $('refresh').onclick=refresh;$('mode').onchange=mode;
  $('supervisor-form').onsubmit=event=>{event.preventDefault();void command('on');};$('disable').onclick=()=>command('off');
  for(const id of ['search','status','sort'])$(id).addEventListener('input',jobs);
  $('filters').onsubmit=event=>event.preventDefault();$('filters').onreset=()=>setTimeout(jobs,0);
  $('preferences').onsubmit=event=>{event.preventDefault();try{preferences={theme:$('theme').value,auto:$('auto').checked};localStorage.setItem('damar.control.preferences',JSON.stringify(preferences));apply();$('saved').textContent='Preferences saved on this device.';}catch{$('saved').textContent='Storage unavailable. Preferences were not persisted.';}};
  setInterval(()=>{if(preferences.auto&&!busy)void refresh();},5000);
  setInterval(()=>{$('job-cancel-dialog').disabled=jobBusy;},100);
  void refresh();
})();
