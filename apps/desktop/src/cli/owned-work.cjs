'use strict';
const {fork}=require('node:child_process');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {restrictedChildEnvironment}=require('./child-environment.cjs');
class OwnedWork {
 constructor({mode='cooperative',onEvent=()=>{},graceMs=500}={}){
  if(!['cooperative','uncooperative'].includes(mode)||graceMs<100||graceMs>1000)throw Error('INVALID_DIAGNOSTIC_WORK');
  this.stopped=false;this.requested=false;this.escalated=false;this.timer=null;this.started=performance.now();
  this.child=fork(path.join(__dirname,'bounded-worker.cjs'),[mode],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:restrictedChildEnvironment(),execArgv:[]});
  this.done=new Promise(resolve=>{
   this.child.once('exit',(code,signal)=>{this.stopped=true;clearTimeout(this.timer);const result={type:'EXIT',pid:this.child.pid,code,signal,requested:this.requested,escalated:this.escalated,elapsedMs:performance.now()-this.started};onEvent(result);resolve(result);});
  });
  this.child.on('error',()=>{onEvent({type:'WORKER_FAILED'});});
  this.child.on('message',message=>{if(['READY','PROGRESS','STOPPED'].includes(message?.type))onEvent(message);});
  this.graceMs=graceMs;
 }
 cancel(){
  if(this.stopped||this.requested)return false;
  this.requested=true;
  if(this.child.connected)this.child.send({type:'STOP'},()=>{});
  this.timer=setTimeout(()=>this.escalate(),this.graceMs);return true;
 }
 escalate(){
  if(this.stopped||this.escalated)return false;
  this.escalated=true;
  // Exact ChildProcess handle only. The fixed worker never spawns descendants.
  // Windows kill is forceful, so graceful cancellation is the explicit IPC above.
  return this.child.kill();
 }
}
module.exports={OwnedWork};
