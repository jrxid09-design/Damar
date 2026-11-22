'use strict';
// Fixed local diagnostic workload. No shell, provider, filesystem writes or descendant processes.
let stopping=false;
const mode=process.argv[2];
if(!['cooperative','uncooperative'].includes(mode))process.exit(2);
process.on('message',message=>{
 if(message?.type==='STOP'&&mode==='cooperative'&&!stopping){
  stopping=true; clearInterval(work);process.send?.({type:'STOPPED'});process.disconnect?.();
 }
});
process.on('disconnect',()=>process.exit(0));
const work=setInterval(()=>{process.send?.({type:'PROGRESS',at:Date.now()});},100);
process.send?.({type:'READY',pid:process.pid});
