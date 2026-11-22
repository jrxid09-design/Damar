'use strict';
// Adapt the retained presence shell to the actual candidate, not the old shadow feed.
(() => {
  let stopped=false;
  const style=document.createElement('style');
  // The private desktop standby surface owns only the Orb/Notch, not the
  // legacy dashboard's decorative modules or unavailable conversation shell.
  style.textContent='body.siri-dock-active > :not(script):not(style):not(#damarIsland):not(#damarIslandWake):not(#siriOrbDock){visibility:hidden!important;pointer-events:none!important}body.siri-dock-active{background:transparent!important}';
  document.head.append(style);
  async function refresh(){
    if(stopped)return;
    const badge=document.getElementById('r7r3PresenceStatus')||document.createElement('span');
    badge.id='r7r3PresenceStatus';badge.setAttribute('role','status');
    const target=document.getElementById('dynamicStatusBadge');if(target&&!badge.isConnected)target.append(badge);
    try{const r=await fetch('/api/r7r3/overview',{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error();const s=await r.json();badge.textContent=`Local runtime online · Werkudara ${s.supervisor.enabled?'ON':'OFF'}`;}catch{badge.textContent='Local runtime offline · Control can retry';}
  }
  // Start the existing standby Orb, rather than leaving the full prototype in front.
  // The legacy intro has its own async startup state. Establish the desktop
  // standby class after it settles, without starting microphone recognition.
  let entered=false;
  const standby=setInterval(()=>{
    if(window.enterPrivateStandby?.()){
      if(!entered&&sessionStorage.getItem('damar-r4-notch-started')==='1')window.dispatchEvent(new CustomEvent('damar-island-notification',{detail:{substantive:true}}));
      entered=true;
    }
  },200);
  void refresh();const timer=setInterval(refresh,5000);
  window.addEventListener('pagehide',()=>{stopped=true;clearInterval(timer);clearInterval(standby);},{once:true});
})();
