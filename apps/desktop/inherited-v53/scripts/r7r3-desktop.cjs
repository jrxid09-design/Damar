'use strict';
// The shell and service share one lifecycle; no detached daemon is launched.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { start } = require('../src/r7r3/launcher.cjs');
const endpoint = require('../src/r7r3/endpoint.cjs');
const directory=process.argv[2];
if (!directory || process.env.NODE_OPTIONS) throw Error('EXPLICIT_CLEAN_SESSION_REQUIRED');
const recoveryIndex=process.argv.indexOf('--recover-from');
if(recoveryIndex!==-1){
  const {recover}=require('./r7r3-recover.cjs');
  recover(process.argv[recoveryIndex+1],directory);
}
const starting=start({directory,port:endpoint.port,recovered:recoveryIndex!==-1,resume:process.argv.includes('--resume'),mockReview:process.argv.includes('--mock-review')});
// start() establishes the guarded session synchronously before its first await.
const profile=path.join(directory,'electron-profile'); fs.mkdirSync(profile,{recursive:true});
app.setPath('userData',profile); app.setPath('sessionData',profile);
module.exports=starting.then(runtime=>{
  process.env.DAMAR_UI_RUNTIME_URL=runtime.address;
  process.env.DAMAR_TOKEN=runtime.credentials.requester;
  process.env.DAMAR_PRIVATE_SESSION=runtime.directory;
  let closing=false;
  app.on('before-quit',event=>{
    if(closing) return;
    event.preventDefault(); closing=true;
    runtime.stop().finally(()=>app.quit());
  });
  const shell=require('../ui-surfaces/w5/main.js');
  return {runtime,shell};
}).catch(error=>{
  console.error('DESKTOP_START_FAILED',error.code || error.message);
  if(['EACCES','EADDRINUSE'].includes(error.code))console.error('Approved loopback endpoint '+endpoint.origin+' unavailable. No fallback, process termination or Windows policy change. Preserve session locks and inspect the endpoint conflict.');
  app.exit(1);
});
