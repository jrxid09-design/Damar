'use strict';
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[];
require('./r7r3-desktop.cjs').then(async({runtime,shell})=>{
 let win;
 try{
  await app.whenReady();
  for(let i=0;i<100;i++){win=shell.getWindow();if(win&&!win.webContents.isLoading())break;await sleep(100);}
  const js=code=>win.webContents.executeJavaScript(code);
  const wait=async(code,limit=15000)=>{const end=Date.now()+limit;while(Date.now()<end){if(await js(code))return;await sleep(100);}throw Error('Timed out: '+code);};
  const errors=[];win.webContents.on('console-message',(_event,...args)=>{if(args[0]===3)errors.push(args[1]);});
  await wait("document.getElementById('damarIsland') !== null");
  const initial=await js("document.getElementById('damarIsland').dataset.state");
  results.push({name:'real Electron cold start',state:initial,pid:process.pid});
  await wait("['compact','expanded'].includes(document.getElementById('damarIsland').dataset.state)",18000);
  results.push({name:'real 10 second Orb-to-Notch timer',state:await js("document.getElementById('damarIsland').dataset.state")});
  await js("document.querySelector('#damarIsland').dispatchEvent(new MouseEvent('mouseenter'))");await sleep(700);
  const diagnostics=await js("window.__DAMAR_ISLAND__?.getRendererDiagnostics?.() || null");
  assert.equal(await js("document.querySelectorAll('#damarIsland canvas').length"),1);
  results.push({name:'single character canvas after expansion',diagnostics});
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await sleep(400);
  assert.equal(await js("document.getElementById('damarIsland').dataset.state"),'hidden');
  await js("window.damarDesktop.setIgnoreMouse(true)");await sleep(100);
  assert.equal(shell.getMousePolicy().ignored,true);
  results.push({name:'real Electron click-through IPC applies ignore-mouse policy',physicalClickDelivery:'NOT_RUN'});
  // Renderer mouse events exercise the real hit-test bridge, not physical OS input.
  await js("document.dispatchEvent(new MouseEvent('mousemove',{clientX:innerWidth/2,clientY:100,bubbles:true}));document.dispatchEvent(new MouseEvent('mousemove',{clientX:innerWidth/2,clientY:2,bubbles:true}))");
  await wait("['compact','expanded'].includes(document.getElementById('damarIsland').dataset.state)");
  results.push({name:'fresh top-edge renderer pointer reveal without Orb resurrection',kind:'EMULATED_POINTER_REAL_ELECTRON'});
  // The native cursor poll owns subsequent policy; do not assert a stale
  // emulated cursor position against a real pointer outside the island.
  await js("window.damarDesktop.setIgnoreMouse(false)");
  await js("document.querySelector('#damarIsland [data-action=dashboard]').click()");await wait("location.pathname==='/cc2' && document.getElementById('connection')?.textContent.startsWith('Online')");
   results.push({name:'Notch Control button navigation with live service'});
   for(const factor of [1,2]){
     win.webContents.setZoomFactor(factor);await sleep(300);
     assert.equal(win.webContents.getZoomFactor(),factor);
     assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
     await js("document.getElementById('requester').focus()");assert.equal(await js("document.activeElement.id"),'requester');
     fs.writeFileSync(path.join(runtime.directory,'control-native-zoom-'+factor+'.png'),(await win.webContents.capturePage()).toPNG());
   }
   win.webContents.setZoomFactor(1);results.push({name:'native webContents zoom 100 and 200 percent, Control input focus and no overflow'});
   await js("document.querySelector('header a[href=\"/mobile\"]').click()");await wait("location.pathname==='/mobile' && document.getElementById('mobileLiveResult')?.textContent.includes('LIVE_LOCAL_SERVICE')");
   for(const factor of [1,2]){win.webContents.setZoomFactor(factor);await sleep(300);assert.equal(win.webContents.getZoomFactor(),factor);assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);await js("document.getElementById('mobilePromptInput').focus()");assert.equal(await js('document.activeElement.id'),'mobilePromptInput');fs.writeFileSync(path.join(runtime.directory,'mobile-native-zoom-'+factor+'.png'),(await win.webContents.capturePage()).toPNG());}
   win.webContents.setZoomFactor(1);results.push({name:'Mobile native zoom 100 and 200 percent, command focus and no horizontal overflow'});
   await js("document.querySelector('[data-tab=matrix]').click();document.getElementById('mobileJobsRefresh').click()");
   await wait("document.getElementById('mobileLiveResult').textContent.includes('EMPTY')");
   await js("document.getElementById('mobileJobsControl').click()");await wait("location.pathname==='/cc2' && document.getElementById('connection')?.textContent.startsWith('Online')");
   results.push({name:'native Control Mobile jobs Control navigation, actual local readback'});
  await js("document.querySelector('header a').click()");await wait("location.pathname==='/s/idle_presence' && document.getElementById('damarIsland') !== null");
  assert.notEqual(await js("document.getElementById('damarIsland').dataset.state"),'orb');results.push({name:'Control return navigation without Orb resurrection'});
  await wait("['compact','expanded'].includes(document.getElementById('damarIsland').dataset.state)");
  await js("document.querySelector('#damarIsland').dispatchEvent(new MouseEvent('mouseenter'))");await sleep(800);
  const image=await win.webContents.capturePage();fs.writeFileSync(path.join(runtime.directory,'desktop-demo.png'),image.toPNG());
  fs.writeFileSync(path.join(runtime.directory,'desktop-demo.json'),JSON.stringify({status:'PASS',checks:results,consoleErrors:errors,physicalHitTesting:'NOT_RUN',physicalDPI:'NOT_RUN'},null,2));
  console.log(JSON.stringify({status:'PASS',directory:runtime.directory,checks:results.length}));
 }catch(error){fs.writeFileSync(path.join(runtime.directory,'desktop-demo-failure.json'),JSON.stringify({error:error.stack,checks:results},null,2));console.error(error);process.exitCode=1;}
 finally{await runtime.stop();app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
