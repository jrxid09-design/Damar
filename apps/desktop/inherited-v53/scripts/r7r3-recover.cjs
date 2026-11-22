'use strict';
// Recover into a NEW identity. Never remove a crashed process's lock or mutate
// the interrupted source session. Persisted ON/approval state is not imported.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function recover(source,destination,root=process.env.DAMAR_DATA_ROOT){
 if(!root||!path.isAbsolute(root))throw Error('SCRATCH_ROOT_REQUIRED');
 const base=path.resolve(root);
 for(const value of [source,destination]){
  if(!path.isAbsolute(value)||value.split(/[\\/]/).includes('..')||!path.resolve(value).toLowerCase().startsWith(base.toLowerCase()+path.sep))throw Error('SCRATCH_SESSION_REQUIRED');
  for(let p=path.resolve(value);;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('REPARSE_REFUSED');if(path.dirname(p)===p)break;}
 }
 if(fs.existsSync(path.join(source,'FINISHED.json')))throw Error('USE_CLEAN_RESUME_FOR_FINISHED_SESSION');
 const session=JSON.parse(fs.readFileSync(path.join(source,'session.json'),'utf8'));
 if(!Number.isInteger(session.pid)||session.pid<1)throw Error('PROCESS_IDENTITY_UNAVAILABLE');
 try{process.kill(session.pid,0);throw Error('SOURCE_PID_LIVE_OR_REUSED_RECOVERY_REFUSED');}catch(error){if(error.code!=='ESRCH')throw error;}
 const jobs=fs.readFileSync(path.join(source,'jobs.json'));
 const parsed=JSON.parse(jobs);if(parsed.schemaVersion!==1||!Array.isArray(parsed.plans))throw Error('INVALID_JOB_STATE');
 fs.mkdirSync(destination);
 const credentials={owner:crypto.randomBytes(32).toString('hex'),requester:crypto.randomBytes(32).toString('hex')};
 fs.writeFileSync(path.join(destination,'credentials.json'),JSON.stringify(credentials),{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(destination,'jobs.json'),jobs,{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(destination,'RECOVERED_FROM_INTERRUPTION.json'),JSON.stringify({source,sourceJobSHA256:crypto.createHash('sha256').update(jobs).digest('hex'),sourcePid:session.pid,supervisor:'OFF_NEW_LEDGER',approvalGrants:'NOT_RECOVERED',credentials:'ROTATED',at:new Date().toISOString()}),{flag:'wx'});
 // This marker permits controlled startup, and is explicitly not a graceful
 // shutdown marker for the crashed source.
 fs.writeFileSync(path.join(destination,'RECOVERY_READY.json'),'{}',{flag:'wx'});
 return destination;
}
if(require.main===module){try{console.log(recover(process.argv[2],process.argv[3]));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={recover};
