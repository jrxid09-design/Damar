'use strict';
const{app,screen}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
require('./r7r3-desktop.cjs').then(async({runtime,shell})=>{
 const version=process.env.DAMAR_PROOF_VERSION||'v51';
 const out=path.join(runtime.directory,'native-'+version);fs.mkdirSync(out);const checks=[],errors=[];
 try{
  await app.whenReady();let win;for(let i=0;i<100;i++){win=shell.getWindow();if(win&&!win.webContents.isLoading())break;await sleep(100);}
  const js=c=>win.webContents.executeJavaScript(c),capture=async name=>fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());
  win.webContents.on('console-message',(_e,...args)=>{if(args[0]===3)errors.push(String(args[1]));});
  for(let i=0;i<100;i++){if(await js("document.body.classList.contains('siri-dock-active')"))break;await sleep(100);}
  await sleep(300);await capture('01-orb');await sleep(10500);await capture('02-notch');
  await js("document.querySelector('#damarIsland .di-head').click()");await sleep(300);await capture('03-expanded');
  assert.equal(await js("document.querySelector('#damarIsland').innerText.includes('DAMAR NOTCH')"),false);
  checks.push('Original Orb and clean anchored Notch page captures; scripted expand, not physical input');
  await js("document.querySelector('#damarIsland [data-action=dashboard]').click()");await sleep(900);
  assert.equal(new URL(win.webContents.getURL()).pathname,'/cc2');assert.equal(await js('!!window.damarV2Runtime'),true);
  for(const route of ['/cc2','/mobile']){
   if(new URL(win.webContents.getURL()).pathname!==route)await win.loadURL(runtime.address+route);
   for(const zoom of [1,2]){win.webContents.setZoomFactor(zoom);await sleep(400);await capture((route==='/cc2'?'04-control':'05-mobile')+'-zoom-'+zoom);assert.equal(win.webContents.getZoomFactor(),zoom);}
   win.webContents.setZoomFactor(1);
  }
  await js("window.handoffToPcWorkstation()");await sleep(800);assert.equal(new URL(win.webContents.getURL()).pathname,'/cc2');
  await js("document.querySelector('[data-nav-id=cli]').click()");await capture('06-cli-entry');
  // Same PowerShell entrypoint used by the terminal; check mode exits after safe commands.
  const result=await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-File',path.join(__dirname,'OPEN_DAMAR_CLI.ps1'),'-Session',runtime.directory,'-Check'],{windowsHide:true});let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);child.on('exit',code=>resolve({code,output,error}));});
  assert.equal(result.code,0,result.error);checks.push('Session-bound PowerShell launcher help/status/jobs succeeded without credential output');
  // Real terminal launch from actual Control; no terminal keystroke injection.
  await js("document.querySelector('[data-live-action=terminal]').click()");await sleep(1200);
  const terminalError=await js("document.getElementById('cliLaunchResult').textContent");assert.equal(terminalError,'');
  checks.push('Actual Control terminal launch dispatched; physical typing and terminal visibility remain Owner acceptance');
  await js("document.getElementById('openIdlePresenceSidebarBtn').click()");await sleep(800);
  assert.equal(new URL(win.webContents.getURL()).pathname,'/s/idle_presence');
  assert.deepEqual(win.getBounds(),screen.getPrimaryDisplay().workArea);
  checks.push('Single-window Notch / V2 / Mobile / V2 / Presence round-trip and primary work-area bounds');
  const resultDoc={version,status:'PASS_SCOPED',address:runtime.address,checks,errors,physical:'NOT_RUN',captureType:'Electron webContents page capture, transparent surround is not physical desktop proof',bounds:win.getBounds(),display:screen.getPrimaryDisplay().workArea};
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(resultDoc,null,2));console.log(JSON.stringify(resultDoc));
 }catch(e){console.error(e);process.exitCode=1;}
 finally{await runtime.stop();app.exit(process.exitCode||0);}
}).catch(e=>{console.error(e);app.exit(1);});
