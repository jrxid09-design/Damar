'use strict';
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
require('./r7r3-desktop.cjs').then(async({runtime,shell})=>{
  const out=path.join(runtime.directory,'fidelity-smoke');fs.mkdirSync(out);
  const errors=[];let win;
  try{
    await app.whenReady();
    for(let i=0;i<100;i++){win=shell.getWindow();if(win&&!win.webContents.isLoading())break;await sleep(100);}
    win.webContents.on('console-message',(_event,...args)=>{if(args[0]===3)errors.push(String(args[1]));});
    const js=code=>win.webContents.executeJavaScript(code);
    for(let i=0;i<100;i++){if(await js("document.body.classList.contains('siri-dock-active')"))break;await sleep(100);}
    await sleep(600);
    const orb=await js(`(()=>{const e=document.getElementById('siriOrbDock'),c=document.getElementById('siriGlCanvas'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return{rect:r.toJSON(),opacity:s.opacity,visibility:s.visibility,canvas:[c.width,c.height],startup:document.body.dataset.startupState,notch:document.getElementById('damarIsland').dataset.state}})()`);
    fs.writeFileSync(path.join(out,'01-orb.png'),(await win.webContents.capturePage()).toPNG());
    await sleep(11000);
    fs.writeFileSync(path.join(out,'02-notch.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#damarIsland .di-head').click()");await sleep(500);
    fs.writeFileSync(path.join(out,'03-expanded.png'),(await win.webContents.capturePage()).toPNG());
    await win.loadURL(runtime.address+'/cc2');await sleep(1200);
    fs.writeFileSync(path.join(out,'04-control-v2.png'),(await win.webContents.capturePage()).toPNG());
    const control=await js("({title:document.title,shell:!!document.getElementById('dashboardShell'),text:document.getElementById('mainWorkspaceContent')?.innerText.slice(0,1500),adapter:!!window.damarV2Runtime})");
    await js("document.querySelector('[data-nav-id=cli]').click()");await sleep(300);
    fs.writeFileSync(path.join(out,'05-cli-entry.png'),(await win.webContents.capturePage()).toPNG());
    await win.loadURL(runtime.address+'/mobile');await sleep(700);
    fs.writeFileSync(path.join(out,'06-mobile.png'),(await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out,'observations.json'),JSON.stringify({version:'candidate-correction-unsealed',address:runtime.address,orb,control,bounds:win.getBounds(),errors,provenance:'Actual Electron webContents capturePage, not physical desktop capture or mouse acceptance',physical:'NOT_RUN'},null,2));
    console.log(JSON.stringify({out,orb,errors}));
  }catch(error){console.error(error);process.exitCode=1;}
  finally{await runtime.stop();app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
