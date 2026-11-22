'use strict';
(() => {
  const design=window.damarV2Design, state=design.state, esc=design.escape;
  let snapshot=null, problem='', fetched='', busy=false, filter='ALL', search='';
  let dialogReturn=null;
  let unresolved=null;
  const pendingKey='damar.v2.pending-operation';
  function readHold(){try{return JSON.parse(localStorage.getItem(pendingKey)||sessionStorage.getItem(pendingKey)||'null');}catch{return {action:'unknown',planId:null,storageUnavailable:true};}}
  unresolved=readHold();
  const hold=value=>{unresolved=value;try{if(value)localStorage.setItem(pendingKey,JSON.stringify(value));else{localStorage.removeItem(pendingKey);sessionStorage.removeItem(pendingKey);}return true;}catch{unresolved={...value,storageUnavailable:true};return false;}};
  window.addEventListener('storage',event=>{if(event.key===pendingKey){unresolved=readHold();render();}});
  // Only local navigation preferences survive. Prototype task/approval fixtures do not.
  Object.assign(state,{surface:'dashboard',endpointPort:'127.0.0.1:29623',tasks:[],approvals:[],activities:[],models:[],providers:[]});
  const main=document.getElementById('mainWorkspaceContent');
  const button=(text,action)=>`<button type="button" class="btn btn-secondary btn-sm" data-live-action="${action}">${text}</button>`;
  const panel=(title,body)=>`<section class="panel"><div class="panel-header"><h2 class="panel-title">${title}</h2></div><div class="panel-body">${body}</div></section>`;
  const go=surface=>window.damarDesktop?.navigateSurface?window.damarDesktop.navigateSurface(surface):location.assign(surface==='mobile'?'/mobile':'/s/idle_presence');
  function rows(){return snapshot?[...new Map([...snapshot.pendingPlans,...snapshot.jobs,...snapshot.failures].map(row=>[row.planId,row])).values()]:[];}
  function taskTable(){
    const items=rows().filter(row=>(filter==='ALL'||row.status===filter)&&JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
    return panel('Active Tasks &amp; Execution',`<div class="page-actions"><label>Search <input class="input-field" id="liveSearch" value="${esc(search)}"></label><label>Status <select class="select-field" id="liveFilter">${['ALL',...new Set(rows().map(r=>r.status))].map(s=>`<option${s===filter?' selected':''}>${esc(s)}</option>`).join('')}</select></label>${button('New SHA-256 plan','plan')}</div><div class="table-responsive"><table class="data-table"><thead><tr><th>Plan / job</th><th>Status</th><th>Version</th><th>Action</th></tr></thead><tbody>${items.map(row=>`<tr><td>${esc(row.planId)}</td><td>${esc(row.status)}</td><td>${esc(String(row.version))}</td><td><button class="btn btn-secondary btn-sm" data-live-inspect="${esc(row.planId)}">Inspect</button></td></tr>`).join('')}</tbody></table></div>${!items.length?'<p>No matching local plans or jobs. Create a bounded SHA-256 plan to begin.</p>':''}`);
  }
  function render(){
    design.sidebar();design.header();
    document.querySelectorAll('#sidebarNavContainer .nav-item-badge').forEach(e=>e.remove());
    const name=document.querySelector('[data-nav-id="'+state.activeView+'"] .nav-item-label')?.textContent||'Overview';
    document.getElementById('runtimeTruthBadgeBtn').textContent=problem?'OFFLINE':snapshot?'LIVE_LOCAL_SERVICE':'Connecting';
    document.getElementById('topbarPendingCount').textContent=String(snapshot?.pendingPlans.length||0);
    const heading=`<div class="page-header"><div class="page-title-group"><span class="page-kicker">PRIVATE LOCAL RUNTIME</span><h1 class="page-title">${esc(name)}</h1><p class="page-subtitle">${esc(problem||'Authoritative local service, bounded synthetic jobs only.')}</p></div><div class="page-actions">${button('Refresh runtime','refresh')}${button('Mobile preview','mobile')}${button('Open CLI','cli')}</div></div>`;
    let content='';
    if(state.activeView==='overview'){
      // Reuse the original V2 composition, with no fixture tasks, approvals or providers.
      const box=document.createElement('div');box.innerHTML=design.overview();
      box.querySelector('.page-header')?.remove();box.querySelector('.governance-strip')?.remove();
      const tiles=[...box.querySelectorAll('.signal-tile')];
      const values=[['Runtime State',snapshot?'ONLINE':'UNAVAILABLE','Local service readback'],['Active Tasks',String(rows().length),'Persisted plans / jobs'],['Available Models','Metadata only','Open Models to fetch catalog'],['Connected Providers',snapshot?.provider.kind||'Unavailable',snapshot?.provider.reason||'No readback'],['Pending Approvals',String(snapshot?.pendingPlans.length||0),'Separate owner approval required'],['System Health','Unavailable','No hardware health telemetry']];
      tiles.forEach((tile,i)=>{const v=values[i];if(!v)return;tile.innerHTML=`<div class="signal-top"><span class="signal-label">${v[0]}</span></div><div class="signal-value-row"><div class="signal-value">${esc(v[1])}</div></div><div class="signal-meta">${esc(v[2])}</div>`;tile.setAttribute('role','button');tile.tabIndex=0;});
      const sections=[...box.querySelectorAll('section.panel')];
      sections.forEach((section,i)=>{if(i===0)section.outerHTML=taskTable();else{const title=section.querySelector('h2')?.textContent||'Prototype module';let body='Belum tersedia: this designed module has no authorized runtime binding. No simulated telemetry or action is presented.';if(title.includes('Approvals'))body=esc(String(snapshot?.pendingPlans.length||0))+' local plans await separate Owner review. Open Tasks and Inspect the actual plan.';if(title.includes('Activity')||title.includes('Events'))body=esc(JSON.stringify(snapshot?.events?.slice(-3)||[]));section.innerHTML=`<div class="panel-header"><h2 class="panel-title">${esc(title)}</h2></div><div class="panel-body"><p>${body}</p></div>`;}});
      // Remove residual prototype samples outside panels, preserving the layout grid.
      box.querySelectorAll('[data-approve],[data-reject],[data-inspect-approval]').forEach(e=>e.remove());
      content=box.innerHTML;
    }else if(state.activeView==='tasks')content=taskTable();
    else if(state.activeView==='runtime'||state.activeView==='automations')content=panel('Werkudara supervision',`<p>Starts OFF. Finite MOCKED review only; separate Owner authorization required.</p><pre>${esc(JSON.stringify(snapshot?.supervisor||{state:'unavailable'},null,2))}</pre>${button('Enable one MOCKED review','supervisor-on')}${button('Switch OFF','supervisor-off')}`);
    else if(state.activeView==='providers'||state.activeView==='models')content=panel('Provider metadata',`<p>Provider connections are managed in DAMAR Control > Providers. Metadata only; no inference or latency claims.</p>${button('Read model catalog','models')}<pre id="liveModels">Not fetched in this view.</pre>`);
    else if(state.activeView==='cli')content=panel('Damar CLI',`<p>Launch the terminal for this private session. Credentials stay in the session folder; no values are displayed here.</p>${button('Launch DAMAR terminal','terminal')}<p>In the terminal: <code>damar --help</code>, <code>damar status --json</code>, <code>damar jobs --json</code>.</p><p>Node and Python share the same service. Approval requires explicit <code>--owner</code>. No automatic approval.</p><p id="cliLaunchResult" role="status"></p>`);
    else if(['activity','logs','diagnostics'].includes(state.activeView))content=panel('Local runtime readback',`<pre>${esc(JSON.stringify(snapshot?.events||[],null,2))}</pre><p>No device health or security certification is implied.</p>`);
    else if(state.activeView==='security')content=taskTable();
    else content=panel(esc(name),'<p>Belum tersedia: this original V2 module has no authorized backend capability in this private preview. No simulated action or telemetry is claimed.</p>');
    main.innerHTML=heading+`<div class="governance-strip"><p>127.0.0.1:29623 · ${esc(fetched?'Read '+fetched:'Awaiting service readback')} · private candidate, not production.</p>${unresolved?'<p role="alert">An operation needs explicit reconciliation. Mutations are held; no replay.</p>'+button('Inspect unresolved operation','reconcile'):''}</div>`+content;
    main.querySelector('#liveSearch')?.addEventListener('input',event=>{search=event.target.value;const pos=event.target.selectionStart;render();const input=document.getElementById('liveSearch');input.focus();input.setSelectionRange(pos,pos);});
    main.querySelector('#liveFilter')?.addEventListener('change',event=>{filter=event.target.value;render();});
  }
  async function refresh(){
    try{const response=await fetch('/api/r7r3/overview',{signal:AbortSignal.timeout(3000),cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const next=await response.json();if(next.connection!=='online'||typeof next.runtimeInstanceId!=='string'||!Array.isArray(next.jobs)||!Array.isArray(next.pendingPlans)||!Array.isArray(next.failures)||!Array.isArray(next.events)||typeof next.supervisor?.enabled!=='boolean')throw Error('Unrecognized authoritative readback');snapshot=next;problem='';fetched=new Date().toLocaleTimeString();}
    catch(error){snapshot=null;problem='Local runtime unavailable: '+error.message;}
    render();
  }
  function close(){if(busy)return;document.getElementById('detailDrawerBackdrop').classList.remove('open');document.getElementById('drawerBodyContent').replaceChildren();if(dialogReturn?.isConnected)dialogReturn.focus();else document.getElementById('runtimeTruthBadgeBtn').focus();}
  function show(title,html){dialogReturn=document.activeElement;design.drawer('LOCAL AUTHORIZED WORKFLOW',title,html);document.querySelector('#drawerBodyContent input, #closeDetailDrawerBtn')?.focus();}
  function operation(action,row){
    unresolved=readHold();
    if(busy||unresolved){show('Reconciliation required','<p>No new mutation sent. Inspect the unresolved operation and authoritative state first.</p>');return;}
    show(action==='plan'?'Create bounded SHA-256 plan':action+' '+row.planId,`<form id="liveOperation"><p>${action==='approve'||action==='revoke'?'Separate Owner credential required.':'Requester credential required.'} This action uses the existing service authority.</p><label>Credential <input class="input-field" type="password" id="liveCredential" autocomplete="off" required></label>${action==='plan'?'<label>Synthetic text <input class="input-field" id="liveText" maxlength="2048" required></label>':''}${action==='execute'?'<label>Approval grant <input class="input-field" id="liveGrant" type="password" required autocomplete="off"></label>':''}<label><input type="checkbox" required> I reviewed this ${esc(action)} action${row?' for '+esc(row.planId)+' version '+esc(String(row.version)):''}.</label><button class="btn btn-primary" type="submit">Send ${esc(action)}</button><p id="liveOperationResult" role="status">No action sent.</p></form>`);
    document.getElementById('liveOperation').onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      if(!navigator.locks){document.getElementById('liveOperationResult').textContent='Mutation unavailable: cross-tab locking is not supported.';return;}
      await navigator.locks.request('damar.v2.mutation',{ifAvailable:true},async lock=>{
      unresolved=readHold();if(!lock||unresolved){document.getElementById('liveOperationResult').textContent='Mutation held: another operation needs reconciliation.';return;}busy=true;
      const output=document.getElementById('liveOperationResult'),credential=document.getElementById('liveCredential');
      const body=action==='plan'?{text:document.getElementById('liveText').value,syntheticData:true}:{planId:row.planId,version:row.version};
      if(action==='execute'){body.approvalId=document.getElementById('liveGrant').value;body.requestId=crypto.randomUUID();}
      if(!snapshot){busy=false;document.getElementById('liveOperationResult').textContent='Mutation blocked: refresh authoritative state first.';return;}
      if(!hold({action,runtimeInstanceId:snapshot.runtimeInstanceId,planId:row?.planId||null,version:row?.version||null,requestId:body.requestId||null,startedAt:new Date().toISOString()})){busy=false;document.getElementById('liveOperationResult').textContent='Mutation blocked: pending-operation storage unavailable. No request sent.';return;}
      const key=credential.value;credential.value='';event.submitter.disabled=true;output.textContent='Sending once. Do not retry an unknown outcome.';
      try{const response=await fetch('/api/r7r3/jobs/'+action,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const result=await response.json();if(response.ok){const data=result?.data;if(result.success!==true||data?.schemaVersion!==1||data.authority!=='isolated-test'||typeof data.planId!=='string'||(row&&data.planId!==row.planId)||(action!=='revoke'&&(!Number.isSafeInteger(data.version)||(row&&data.version!==row.version)))||(action==='approve'&&typeof data.approvalId!=='string')||(action==='verify'&&data.verified!==true)||(action==='execute'&&!['QUEUED','WORKING','VERIFIED'].includes(data.status))||(action==='revoke'&&data.revoked!==true))throw Error('Unrecognized service response');}else if(result.success!==false||typeof result.error?.code!=='string')throw Error('Unrecognized denial');hold(null);output.textContent=JSON.stringify(result,null,2);}
      catch(error){output.textContent='Outcome unknown: '+error.message+'. Close and refresh authoritative state before any further action. No automatic retry.';}
      finally{busy=false;}
      });
    };
  }
  window.damarV2Runtime={render};
  document.addEventListener('click',async event=>{
    const inspect=event.target.closest('[data-live-inspect]');
    if(inspect){const row=rows().find(r=>r.planId===inspect.dataset.liveInspect);show('Plan / job',`<pre>${esc(JSON.stringify(row,null,2))}</pre>${['approve','execute','verify','cancel','revoke'].map(a=>button(a,a+':'+row.planId)).join('')}<p>Actions can be denied by the service based on current status, role or version. Close and refresh after a mutation.</p>`);return;}
    const action=event.target.closest('[data-live-action]')?.dataset.liveAction;
    if(!action)return;
    if(action==='reconcile'){
      await refresh();
      show('Unresolved operation readback',`<pre>${esc(JSON.stringify({operation:unresolved,authorityChanged:!snapshot||unresolved?.runtimeInstanceId!==snapshot.runtimeInstanceId,currentRuntimeInstanceId:snapshot?.runtimeInstanceId,current:rows().find(r=>r.planId===unresolved?.planId)||null,supervisor:snapshot?.supervisor,events:snapshot?.events||[],readAt:fetched},null,2))}</pre><p>No request is replayed. An approval grant is never recovered or reused. A changed authority or missing plan does NOT prove the old operation failed. Preserve the original session for investigation. Age never clears this hold.</p><label><input id="reconcileAcknowledgement" type="checkbox"> I reviewed the authoritative state and will not replay the unknown operation.</label>${button('Acknowledge readback, clear local hold','clear-hold')}`);return;
    }
    if(action==='clear-hold'){if(snapshot&&!busy&&document.getElementById('reconcileAcknowledgement')?.checked&&navigator.locks)await navigator.locks.request('damar.v2.mutation',{ifAvailable:true},lock=>{if(lock){hold(null);close();render();}});return;}
    if(action.includes(':')){const[a,id]=action.split(':');operation(a,rows().find(r=>r.planId===id));return;}
    if(action==='refresh')void refresh();
    if(action==='mobile')void go('mobile');
    if(action==='cli')design.navigate('cli');
    if(action==='plan')operation('plan');
    if(action==='terminal'){try{if(!window.damarDesktop?.launchCli)throw Error('Use adjacent OPEN_DAMAR_CLI.ps1 with the printed session path.');await window.damarDesktop.launchCli();}catch(error){document.getElementById('cliLaunchResult').textContent=error.message;}}
    if(action==='models'){const output=document.getElementById('liveModels');output.textContent='Loading metadata…';try{const r=await fetch('/api/r7r3/models',{signal:AbortSignal.timeout(4000)});output.textContent=JSON.stringify(await r.json(),null,2);}catch(error){output.textContent='Unavailable: '+error.message;}}
    if(action.startsWith('supervisor-')){
      if(busy||readHold()){show('Reconciliation required','<p>Resolve the pending operation before changing supervision.</p>');return;}
      const enable=action==='supervisor-on';
      show('Owner-gated supervision',`<form id="supervisorOperation"><p>${enable?'Enable EVENT_REVIEW with one MOCKED call and one spend unit. No live inference.':'Switch Werkudara OFF.'} Separate Owner credential required.</p><label>Owner credential <input id="supervisorCredential" class="input-field" type="password" autocomplete="off" required></label><label><input type="checkbox" required> I reviewed this ${enable?'finite MOCKED enable':'OFF'} action.</label><button type="submit" class="btn btn-primary">Confirm ${enable?'enable':'OFF'}</button><p id="supervisorResult" role="status">No action sent.</p></form>`);
      document.getElementById('supervisorOperation').onsubmit=async event=>{
        event.preventDefault();if(busy||!navigator.locks)return;
        await navigator.locks.request('damar.v2.mutation',{ifAvailable:true},async lock=>{
          const output=document.getElementById('supervisorResult');if(!lock||readHold()){output.textContent='Mutation held; reconcile first.';return;}
          if(enable&&snapshot?.provider.kind!=='MOCKED'){output.textContent='Unavailable: startup did not configure a MOCKED provider. No request sent.';return;}
          if(!snapshot){output.textContent='Refresh authoritative state first. No request sent.';return;}
          if(!hold({action,runtimeInstanceId:snapshot.runtimeInstanceId,startedAt:new Date().toISOString()})){output.textContent='Storage unavailable. No request sent.';return;}
          busy=true;event.submitter.disabled=true;const field=document.getElementById('supervisorCredential'),key=field.value;field.value='';
          try{const response=await fetch('/api/r7/supervisor/'+(enable?'on':'off'),{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(enable?{mode:'EVENT_REVIEW',maxCalls:1,maxSpendUnits:1}:{}),signal:AbortSignal.timeout(5000)});const result=await response.json();if(response.ok){if(result.success!==true||result.data?.schemaVersion!==1||result.data.authority!=='isolated-test'||result.data.enabled!==enable)throw Error('Unrecognized supervisor readback');}else if(result.success!==false||typeof result.error!=='string')throw Error('Unrecognized denial');hold(null);output.textContent=JSON.stringify(result,null,2);}catch(error){output.textContent='Outcome unknown: '+error.message+'. Reconcile actual supervisor state. No replay.';}finally{busy=false;}
        });
      };
    }
  });
  for(const id of ['brandHomeBtn','runtimeTruthBadgeBtn'])document.getElementById(id).onclick=()=>{state.activeView='overview';void refresh();};
  document.getElementById('sidebarCollapseBtn').onclick=()=>{state.sidebarCollapsed=!state.sidebarCollapsed;document.getElementById('dashboardShell').classList.toggle('sidebar-collapsed',state.sidebarCollapsed);};
  document.getElementById('mobileMenuBtn').onclick=()=>document.getElementById('dashboardShell').classList.toggle('mobile-drawer-open');
  document.getElementById('openIdlePresenceSidebarBtn').onclick=()=>void go('presence');
  document.getElementById('topbarNewTaskBtn').onclick=()=>operation('plan');
  document.getElementById('topbarNotifBtn').onclick=()=>design.navigate('security');
  document.getElementById('topbarSettingsBtn').onclick=()=>design.navigate('settings');
  document.getElementById('cmdPaletteTriggerBtn').onclick=()=>show('Workspace navigation',Array.from(document.querySelectorAll('[data-nav-id]')).map(e=>`<button class="btn btn-secondary" data-live-view="${e.dataset.navId}">${esc(e.textContent)}</button>`).join(''));
  document.addEventListener('click',e=>{const v=e.target.closest('[data-live-view]')?.dataset.liveView;if(v){close();design.navigate(v);}const jump=e.target.closest('[data-jump-view]')?.dataset.jumpView;if(jump)design.navigate(jump);});
  document.getElementById('closeDetailDrawerBtn').onclick=close;
  document.addEventListener('keydown',e=>{if(e.key==='Escape')close();if(e.key==='Tab'&&document.getElementById('detailDrawerBackdrop').classList.contains('open')){const nodes=[...document.querySelectorAll('#detailDrawerBackdrop button:not(:disabled),#detailDrawerBackdrop input:not(:disabled)')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}if((e.key==='Enter'||e.key===' ')&&e.target.matches('.signal-tile')){e.preventDefault();e.target.click();}});
  document.getElementById('idlePresenceSurface').remove();
  render();void refresh();
})();
