'use strict';
const {EventEmitter}=require('node:events');
const readline=require('node:readline');
const {StringDecoder}=require('node:string_decoder');
const {Editor}=require('./editor.cjs');
const width=cell=>/\p{Extended_Pictographic}/u.test(cell)||/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(cell)?2:cell==='\t'?4:1;
class TerminalInput extends EventEmitter{
  constructor({input=process.stdin,output=process.stdout,nativeInput=false}={}){
  super();this.input=input;this.output=output;this.editor=new Editor();this.closed=false;this.rows=1;this.cursorRow=0;this.search=null;this.paste=false;this.pasteText='';this.pending='';this.rendered=false;
  this.utf8=new StringDecoder('utf8');
  this.key=(text,key)=>this.onKey(text,key||{});this.data=chunk=>this.decode(typeof chunk==='string'?chunk:this.utf8.write(chunk));this.resize=()=>this.render();this.ended=()=>this.close();
  // Decode on an owned stream so bracketed paste never reaches command submission logic.
  const {PassThrough}=require('node:stream');this.decoder=new PassThrough();
  readline.emitKeypressEvents(this.decoder,{escapeCodeTimeout:25});this.decoder.on('keypress',this.key);
   this.nativeInput=nativeInput;this.wasRaw=!!input.isRaw;if(!nativeInput){input.setRawMode(true);input.on('data',this.data);input.resume();}input.once('end',this.ended);output.on('resize',this.resize);
  output.write('\x1b[?2004h');
 }
 decode(text){
  clearTimeout(this.escapeTimer);
  // Unbracketed multiline clipboard bursts remain drafts. A single trailing Enter is a submit key.
  if(!this.paste&&!this.pending&&!text.includes('\x1b')&&/[\r\n]/.test(text.replace(/[\r\n]$/,''))){
   try{this.editor.insert(text);}catch{this.emit('inputError','PASTE_REJECTED');}this.render();return;
  }
  this.pending+=text;
  while(this.pending){
   const marker=this.paste?'\x1b[201~':'\x1b[200~';
   const index=this.pending.indexOf(marker);
   if(index>=0){
    const before=this.pending.slice(0,index);this.pending=this.pending.slice(index+marker.length);
    if(this.paste){this.pasteText+=before;try{if(this.pasteOverflow)throw Error('PASTE_TOO_LARGE');this.editor.insert(this.pasteText);}catch{this.emit('inputError','PASTE_REJECTED');}this.pasteText='';this.paste=false;this.pasteOverflow=false;this.render();}
    else{if(before)this.decoder.write(before);this.paste=true;}
    continue;
   }
   let keep=0;for(let n=1;n<marker.length;n++)if(this.pending.endsWith(marker.slice(0,n)))keep=n;
   const ready=this.pending.slice(0,this.pending.length-keep);this.pending=this.pending.slice(this.pending.length-keep);
   if(this.paste){this.pasteText+=ready;if(Buffer.byteLength(this.pasteText)>8192){this.pasteText='';this.emit('inputError','PASTE_TOO_LARGE');this.pasteOverflow=true;}}
   else if(ready)this.decoder.write(ready);
    if(keep&&!this.paste){this.escapeTimer=setTimeout(()=>{const rest=this.pending;this.pending='';if(rest==='\x1b')this.onKey(rest,{name:'escape'});else this.decoder.write(rest);},25);}
   break;
  }
 }
 onKey(text,key){
  if(this.closed)return;
   if(key.ctrl&&key.name==='c'){this.emit('SIGINT',{repeat:!!key.repeat,native:!!key.native});return;}
  if(key.ctrl&&key.name==='d'&&!this.editor.text){this.close();return;}
   if(key.name==='escape'){if(this.search){this.editor.replace(this.search.draft);this.search=null;this.render();}else this.emit('escape',{repeat:!!key.repeat,native:!!key.native});return;}
  if(key.ctrl&&key.name==='l'){this.output.write('\x1b[2J\x1b[H');this.rendered=false;this.render();return;}
  if(key.ctrl&&key.name==='r'){
   if(!this.search)this.search={query:'',draft:this.editor.text,before:this.editor.history.length};
   const found=this.editor.find(this.search.query,this.search.before);if(found){this.editor.replace(found.text);this.search.before=found.index;}this.render();return;
  }
  if(this.search){
   if(key.name==='return'){this.search=null;this.render();return;}
   if(key.name==='backspace')this.search.query=this.search.query.slice(0,-1);
   else if(text&&!key.ctrl&&!key.meta)this.search.query+=text;
   const found=this.editor.find(this.search.query);if(found)this.editor.replace(found.text);this.render();return;
  }
  try{
   if(key.name==='return'&&!key.alt&&!key.meta&&!key.shift){
    const line=this.editor.text;this.editor.remember(line);this.erase();const name=line.trim().replace(/^\//,'').split(/\s/)[0];const safe=/^(help|status|jobs|doctor|session|catalog|diagnostic|exit|pending|\?)$/.test(line.trim())?line:'['+(/^(plan|approve|execute|verify|revoke|cancel|reconcile)$/.test(name)?name:'input')+' arguments hidden]';if(!this.suppressLineEcho)this.output.write('DAMAR > '+safe+'\r\n');this.editor.clear();this.rendered=false;this.emit('line',line);return;
   }
   if(key.ctrl&&key.name==='j'||key.name==='return')this.editor.insert('\n');
   else if(key.name==='left')key.ctrl||key.meta?this.editor.wordLeft():this.editor.left();
   else if(key.name==='right')key.ctrl||key.meta?this.editor.wordRight():this.editor.right();
   else if(key.name==='home'||key.ctrl&&key.name==='a')this.editor.home();
   else if(key.name==='end'||key.ctrl&&key.name==='e')this.editor.end();
   else if(key.name==='backspace')this.editor.backspace();
   else if(key.name==='delete'||key.ctrl&&key.name==='d')this.editor.delete();
   else if(key.name==='up')this.editor.previous();
   else if(key.name==='down')this.editor.next();
   else if(key.ctrl&&key.name==='u')this.editor.clear();
   else if(text&&!key.ctrl&&!key.meta)this.editor.insert(text);
  }catch{this.emit('inputError','INPUT_REJECTED');}
  this.render();
 }
 erase(){if(!this.rendered)return;this.output.write('\r'+(this.cursorRow?'\x1b['+this.cursorRow+'A':'')+'\x1b[J');this.rendered=false;}
 layout(){
  const cols=Math.max(16,this.output.columns||80),lines=['DAMAR > '];let row=0,column=8,cr=0,cc=8;
  for(let index=0;index<=this.editor.cells.length;index++){
   if(index===this.editor.cursor){cr=row;cc=column;}
   if(index===this.editor.cells.length)break;
   const cell=this.editor.cells[index];
   if(cell==='\n'){lines.push('      > ');row++;column=8;continue;}
   const w=width(cell);if(column+w>=cols){lines.push('');row++;column=0;}
   lines[row]+=cell==='\t'?'    ':cell;column+=w;
  }
  return {lines,cr,cc};
 }
 render(){
  if(this.closed)return;this.erase();const {lines,cr,cc}=this.layout();
  const max=Math.max(2,(this.output.rows||24)-3);let start=Math.max(0,cr-max+1);const visible=lines.slice(start,start+max);
  this.output.write(visible.join('\r\n')+'\r');const below=visible.length-1-(cr-start);
  if(below>0)this.output.write('\x1b['+below+'A');if(cc)this.output.write('\x1b['+cc+'C');
  this.rows=visible.length;this.cursorRow=cr-start;this.rendered=true;
 }
  prompt(){this.render();}
  print(message){
   this.erase();
   // Service strings cannot inject terminal control sequences through diagnostic output.
   const safe=String(message).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
   this.output.write(safe.replace(/\r?\n/g,'\r\n')+'\r\n');
   this.render();
  }
 write(text,key){if(key?.ctrl&&key.name==='u')this.editor.clear();else if(text)this.editor.insert(text);this.render();}
  close(){if(this.closed)return;this.closed=true;clearTimeout(this.escapeTimer);this.input.off('data',this.data);this.input.off('end',this.ended);this.output.off('resize',this.resize);this.decoder.destroy();this.output.write('\x1b[?2004l\x1b[?25h\r\n');if(!this.nativeInput)this.input.setRawMode(this.wasRaw);this.input.pause();this.emit('close');}
}
module.exports={TerminalInput,width};
