'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const readline=require('node:readline');
const {boundedLines}=require('./renderer-protocol.cjs');
const {restrictedChildEnvironment}=require('./child-environment.cjs');
const specials={8:'backspace',9:'tab',13:'return',27:'escape',33:'pageup',34:'pagedown',35:'end',36:'home',37:'left',38:'up',39:'right',40:'down',46:'delete',112:'f1'};
function nativeKey(event){
 if(!event||event.kind!=='key')return null;
 if(typeof event.down!=='boolean'||!Number.isInteger(event.vk)||event.vk<0||event.vk>65535||!Number.isInteger(event.control)||event.control<0||event.control>65535||!Number.isInteger(event.count)||event.count<1||event.count>65535||typeof event.text!=='string'||event.text.length>1||typeof event.repeat!=='boolean')throw Error('INVALID_NATIVE_KEY');
 if(!event.down)return null;
 const ctrl=!!(event.control&12),alt=!!(event.control&3),shift=!!(event.control&16);
 let name=specials[event.vk];
 if(!name&&event.vk>=65&&event.vk<=90)name=String.fromCharCode(event.vk).toLowerCase();
 if(!name&&event.text)name=event.text.toLowerCase();
 return {text:event.text==='\0'?'':event.text,key:{name,ctrl,alt,meta:alt,shift,repeat:event.repeat,native:true},count:event.count};
}
class NativeInput{
 constructor({onKey,onEvent,onFailure}){
   this.stoppedPromise=new Promise(resolve=>{this.resolveStopped=resolve;});
  const prototype=path.resolve(__dirname,'../../prototype-w5-cli/20261114-000108');
  this.child=spawn('python',['-B','-u',path.join(__dirname,'native-input.py'),'--prototype',prototype],{stdio:['pipe','pipe','pipe'],windowsHide:false,env:restrictedChildEnvironment()});
  this.lines=boundedLines();this.child.stdout.pipe(this.lines);this.protocol=readline.createInterface({input:this.lines});
  const fail=()=>{if(!this.closing&&!this.failed){this.failed=true;onFailure('NATIVE_INPUT_FAILED');}};
  this.lines.on('error',fail);this.child.on('error',fail);this.child.stdin.on('error',fail);this.child.stderr.on('data',()=>{});
  this.protocol.on('line',line=>{try{
   const event=JSON.parse(line);
   if(event.kind==='error')return fail();
   if(event.kind==='ready'){clearTimeout(this.deadline);this.ready=true;return onEvent(event);}
    if(event.kind==='stopped'){if(!this.closing)return fail();this.receipt=event;this.resolveStopped(event.restored===true);return onEvent(event);}
   if(!this.ready||this.closing)return;
   const decoded=nativeKey(event);
   if(decoded){
    const unit=decoded.text.charCodeAt(0);
    if(unit>=0xd800&&unit<=0xdbff){this.highSurrogate=decoded.text;return;}
    if(unit>=0xdc00&&unit<=0xdfff){if(!this.highSurrogate)return;decoded.text=this.highSurrogate+decoded.text;}
    this.highSurrogate=null;
    for(let i=0;i<(decoded.key.name==='escape'?1:Math.min(decoded.count,256));i++)onKey(decoded.text,{...decoded.key,repeat:decoded.key.repeat||i>0});
   }else if(event.kind==='paste'){
    if(typeof event.text!=='string')throw Error('INVALID_NATIVE_PASTE');
    if(Buffer.byteLength(event.text)>8192)return onEvent({kind:'inputError',code:'PASTE_REJECTED'});
    onEvent(event);
   }else if(event.kind!=='key')onEvent(event);
  }catch{fail();}});
   this.child.on('close',()=>{clearTimeout(this.deadline);clearTimeout(this.killTimer);if(!this.receipt)this.resolveStopped(false);if(!this.closing)fail();});
  this.deadline=setTimeout(fail,3000);
 }
 close(){
  if(this.closing)return;this.closing=true;clearTimeout(this.deadline);this.child.stdin.end();
   this.killTimer=setTimeout(()=>{if(this.child.exitCode===null)this.child.kill();},1000);this.killTimer.unref();return this.stoppedPromise;
 }
}
module.exports={NativeInput,nativeKey};
