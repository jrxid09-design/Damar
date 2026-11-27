'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {TerminalInput}=require('./input.cjs');
const {rendererCursor}=require('./w5-state.cjs');
const {commandChoices,paletteMatches}=require('./discovery.cjs');
const TITLE_SPINNER=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const {boundedLines}=require('./renderer-protocol.cjs');
const {restrictedChildEnvironment}=require('./child-environment.cjs');
// Session picker search: case-insensitive match over the visible label; ids stay aligned with choices.
function filterSessionPick(pick){
 const q=pick.query.toLowerCase(),rows=pick.all.filter(r=>!q||r.label.toLowerCase().includes(q));
 pick.choices=rows.map(r=>r.label);pick.ids=rows.map(r=>r.id);pick.index=0;
 pick.title=(pick.baseTitle+(pick.query?'  '+pick.searchLabel+': '+pick.query:'')).slice(0,60);
}
class W5Input extends TerminalInput{
 constructor(options={}){
  super(options);this.suppressLineEcho=true;this.messages=[];this.frameBusy=false;this.framePending=false;this.scroll=0;this.activity=false;this.details=false;this.blockExpanded={};this.animationFrame=0;
  const root=path.resolve(__dirname,'../..');
   this.renderer=spawn('python',['-u',path.join(__dirname,'w5-renderer.py'),'--prototype',path.join(root,'w5-cli')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:restrictedChildEnvironment()});
  // End any synchronized-output frame a killed earlier run may have left open (the terminal would hold its display).
  this.output.write('\x1b[?2026l\x1b[?1049h\x1b[?25l');
  this.rendererLines=boundedLines();
  this.rendererLines.on('error',()=>this.failRenderer('W5_RENDERER_PROTOCOL_LIMIT'));
  this.renderer.stdout.pipe(this.rendererLines);
  this.protocol=readline.createInterface({input:this.rendererLines});
  this.protocol.on('line',line=>{
   clearTimeout(this.rendererDeadline);
   this.frameBusy=false;
    if(this.closed)return;
     try{const result=JSON.parse(line);if(result.ok!==true||typeof result.frame!=='string'||Buffer.byteLength(result.frame)>4*1024*1024)throw Error('W5_RENDER_FAILED');this.lastRows=result.frame.split(/\r?\n/).map(row=>row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,''));this.selectionActive=result.selectionActive===true;this.selectionInfo=result.selectionInfo||null;this.introActive=result.introActive===true;this.hitboxes=Array.isArray(result.hitboxes)?result.hitboxes.slice(0,64):[];if(Number.isSafeInteger(result.scrollLimit)&&result.scrollLimit>=0)this.scrollLimit=result.scrollLimit;if(!this.output.write(this.paint(result.frame)+this.titleSequence())){this.outputBlocked=true;this.output.once('drain',()=>{this.outputBlocked=false;if(!this.closed){this.framePending=false;this.render();}});}}
    catch{this.failRenderer('W5_RENDER_FAILED');return;}
   if(this.framePending){this.framePending=false;this.render();}
  });
  this.renderer.on('error',()=>this.failRenderer('PYTHON_RENDERER_UNAVAILABLE'));
  this.renderer.on('exit',()=>{if(!this.closed)this.failRenderer('W5_RENDERER_EXITED');});
  this.renderer.stdin.on('error',()=>{if(!this.closed)this.failRenderer('W5_RENDERER_PIPE_FAILED');});
  this.renderer.stderr.on('data',()=>{});
   // Intro flame animates at half rate (design: animated flame on the welcome screen); work/selection at full rate.
   // Design tick (140 ms): flame, Working glint + MM:SS, ember glow, spinner and window title advance together; the
   // intro-to-chat particle transition gets an extra 70 ms half-tick while it runs (1600 ms).
   this.animation=setInterval(()=>{this.animationTick=(this.animationTick||0)+1;
    const transition=this.transitionStart&&Date.now()-this.transitionStart<1700;
    const subagent=this.messages?.some(m=>m.kind==='pandawa'&&m.pending);
    const blink=this.doneAt&&Date.now()-this.doneAt<6000;
    if(transition||this.animationTick%2===0&&(this.activity||subagent||blink||this.selectionActive||this.introActive&&this.bannerMode!=='static')){if(this.animationTick%2===0)this.animationFrame++;
     // A frame requested in the last 120 ms already covers this tick (never queue a redundant frame behind an input render).
     if(Date.now()-(this.lastRenderAt||0)>=120||transition){this.inTick=true;this.render();this.inTick=false;}}},70);
  this.animation.unref();
   this.render();
   if(options.nativeInput){
    this.native=new (require('./native-input.cjs').NativeInput)({onKey:(text,key)=>this.onKey(text,key),onEvent:event=>this.onNativeEvent(event),onFailure:code=>this.failRenderer(code)});
   }
 }
  erase(){}
  // Clickable chrome from the Live HUD design: the header gear opens Settings, intro cards insert their command.
  // Command palette: visible while the draft is a bare /prefix; Up/Down move the selection, Enter runs, Tab completes,
  // a mouse click on a row runs that command. The selection resets whenever the draft changes.
  paletteNow(){
   if(this.pick||this.approval||this.search||this.activity)return [];
   const items=paletteMatches(this.editor.text,this.language==='id'?'id':'en');
   if(this.editor.text!==this.paletteDraft){this.paletteDraft=this.editor.text;this.paletteIndex=0;}
   if(this.paletteIndex>=items.length)this.paletteIndex=Math.max(0,items.length-1);
   return items;
  }
  // Frame output without flicker: rows are drawn first and then cleared to the end of the line (never erased before
  // drawing, which a terminal can show mid-write as a blank flash anywhere on screen), inside synchronized-output
  // markers (DEC 2026; ignored where unsupported). Animation ticks rewrite only the rows that changed; frames caused by
  // input or state changes, the first frame, a size change or a resize repaint every row.
  paint(frame){
   const lines=frame.split('\n'),prev=this.paintedLines,dims=(this.output.columns||0)+'x'+(this.output.rows||0);let out='\x1b[?2026h';
   if(this.repaintAll||this.pendingFull||!prev||prev.length!==lines.length||dims!==this.paintedDims)out+='\x1b[H'+lines.map(line=>line+'\x1b[0m\x1b[K').join('\n')+'\x1b[J';
   else for(let i=0;i<lines.length;i++)if(lines[i]!==prev[i])out+='\x1b['+(i+1)+';1H'+lines[i]+'\x1b[0m\x1b[K';
   this.repaintAll=false;this.pendingFull=false;this.paintedLines=lines;this.paintedDims=dims;
   return out+'\x1b[?2026l';
  }
  runPalette(cmd){this.editor.replace(cmd);this.onKey('',{name:'return'});}
  // Input-layer diagnostics for the native mouse investigation: coordinates, hit results and selection cell
  // geometry only (never clipboard or selection text). Enabled explicitly via DAMAR_INPUT_DIAG; failures disable it.
  diag(record){
   try{
    const file=process.env.DAMAR_INPUT_DIAG;if(!file||this.diagDisabled)return;
    require('node:fs').appendFileSync(file,JSON.stringify({t:Date.now(),...record})+'\n');
   }catch{this.diagDisabled=true;}
  }
  chromeClick(event){
   if(this.settingsCenter){
    const hit=(this.hitboxes||[]).find(b=>b.y===event.y&&event.x>=b.x0&&event.x<=b.x1&&typeof b.field==='string');
    this.diag({ev:'chromeClick',x:event.x,y:event.y,hit:hit?hit.field:null,option:hit&&hit.option!==undefined?hit.option:null,hitboxes:(this.hitboxes||[]).length,rows:(this.lastRows||[]).length});
    if(hit)Promise.resolve(this.settingsCenter.click(hit)).catch(()=>this.emit('inputError','SETTINGS_ACTION_FAILED'));
    else this.settingsCenter.flash(this.language==='id'?'Klik tidak mengenai kontrol panel.':'Click did not hit a panel control.');
    return true;
   }
   const block=(this.hitboxes||[]).find(b=>b.y===event.y&&event.x>=b.x0&&event.x<=b.x1&&Number.isInteger(b.block));
   if(block&&block.block>=0&&block.block<this.messages.length){
    const key=String(block.block),initial=this.messages[block.block]?.kind==='response'?true:this.details;
    this.blockExpanded[key]=!(Object.hasOwn(this.blockExpanded,key)?this.blockExpanded[key]:initial);
    this.render();return true;
   }
   const palette=this.paletteNow();
   if(palette.length){
    const row=(this.lastRows||[])[event.y]||'';
    const hit=palette.find(item=>row.includes('▸ '+item.cmd+' ')||row.includes('  '+item.cmd+' '));
    if(hit){this.paletteIndex=palette.indexOf(hit);this.runPalette(hit.cmd);return true;}
   }
   const row=(this.lastRows||[])[event.y]||'';
   // Header "Setting" button: the label at the right end of the main header (just before the rail's border).
   const gear=event.y<=3?row.search(/\bSetting(?= *│)/):-1;
   if(gear>=0&&event.x>=gear-1&&event.x<=gear+7){this.emit('line','settings');return true;}
   if(this.introActive){
    for(const cmd of ['/connect','/plan','/skills']){
     // A card is three rows tall; resolve the column on the command row and accept clicks on any card row.
     for(let dy=-2;dy<=2;dy++){const r=(this.lastRows||[])[event.y+dy]||'';const x=r.indexOf('│ '+cmd);if(x>=0&&event.x>=x&&event.x<=x+21&&/[│╭╰]/.test(row.slice(event.x,event.x+1)+row.slice(x,x+1))){this.editor.replace(cmd+(cmd==='/plan'?' ':''));this.render();return true;}}
    }
   }
   return false;
  }
  onNativeEvent(event){
    if(event.kind==='resize'){
     // Windows can deliver a console resize record before Node refreshes stdout.columns/rows.
     // Prefer the native dimensions so the next renderer frame uses the enlarged viewport.
     if(Number.isInteger(event.width)&&event.width>=20)this.output.columns=event.width;
     if(Number.isInteger(event.height)&&event.height>=8)this.output.rows=event.height;
     this.repaintAll=true;this.render();
    }
   else if(event.kind==='wheel'){
    // In a menu the wheel moves the highlighted choice; otherwise it scrolls the transcript.
     if(this.settingsCenter&&!this.approval){const from=this.settingsCenter.current()?.id;this.settingsCenter.wheel(event.delta>0?-1:1);this.diag({ev:'settingsWheel',delta:event.delta,from,to:this.settingsCenter.current()?.id,open:this.settingsCenter.open});}
    else if(this.pick){this.pick.index=Math.min(this.pick.choices.length-1,Math.max(0,this.pick.index+(event.delta>0?-1:1)));this.render();}
    else{this.scroll=Math.max(0,this.scroll+event.delta*3);this.render();}
   }
   else if(event.kind==='mouse_down'&&!this.pick&&!this.approval&&!this.search&&event.button!=='right'&&this.chromeClick(event)){}
   else if(event.kind==='mouse_down'&&this.pick&&!this.approval&&event.button!=='right'){
    // Click on a visible menu row selects and activates it (same path as Enter). Approval modal stays keyboard-only.
    // Prefer exact renderer hitboxes (Settings modal); fall back to matching the visible row text.
    const box=(this.hitboxes||[]).find(b=>b.y===event.y&&event.x>=b.x0&&event.x<=b.x1&&Number.isInteger(b.index)&&b.index<this.pick.choices.length);
    const row=(this.lastRows||[])[event.y]||'';
    const index=box?box.index:this.pick.choices.findIndex(choice=>row.includes(String(choice).slice(0,40)));
    if(index>=0){this.pick.index=index;this.onKey('',{name:'return'});}
   }
   else if(event.kind==='inputError')this.emit('inputError',event.code);
   else if(['mouse_down','mouse_move','mouse_up'].includes(event.kind)&&!this.pick&&!this.approval){
    if(event.kind!=='mouse_move')this.diag({ev:event.kind,x:event.x,y:event.y,button:event.button,settings:!!this.settingsCenter,approval:!!this.approval,selection:this.selectionInfo,selectionActive:this.selectionActive});
    this.mouseEvents??=[];
    if(this.mouseEvents.length>=128){this.mouseEvents=[];this.clearSelection=true;}
    this.mouseEvents.push({kind:event.kind,x:event.x,y:event.y});this.render();
   }
   else if(event.kind==='paste'&&this.settingsCenter&&!this.approval){
    // Paste into the focused Base URL / API Key field (bounded by the field; never into the transcript).
    const center=this.settingsCenter,field=center.current();
    if(field&&['text','secret'].includes(field.kind))for(const ch of String(event.text).replace(/[\r\n]/g,'').slice(0,512))center.typeInto(field.id,ch);
    this.render();
   }
   else if(event.kind==='paste'&&!this.pick&&!this.approval&&!this.search){
    try{this.editor.insert(event.text);}catch{this.emit('inputError','PASTE_REJECTED');}
    this.render();
   }
   this.emit('nativeEvent',event);
  }
 failRenderer(code){
  if(this.closed||this.rendererFailed)return;
  this.rendererFailed=true;
  this.close();
  this.output.write(code+'; terminal restored; runtime left unchanged.\r\n');
  this.emit('rendererFailure',code);
 }
 render(){
  if(this.closed||!this.renderer)return;
  if(!this.inTick)this.pendingFull=true;   // input/state frames repaint every row; animation ticks paint changed rows
  this.lastRenderAt=Date.now();
  if(this.outputBlocked){this.framePending=true;return;}
  if(this.frameBusy){this.framePending=true;return;}
  this.frameBusy=true;
  this.rendererDeadline=setTimeout(()=>this.failRenderer('W5_RENDERER_RESPONSE_TIMEOUT'),3000);
   const mouseEvents=this.mouseEvents||[];this.mouseEvents=[];const clearSelection=!!this.clearSelection,copySelection=!!this.copySelection;this.clearSelection=false;this.copySelection=false;
    const palette=this.paletteNow();
    const transitionMs=this.transitionStart?Date.now()-this.transitionStart:null;
    this.renderer.stdin.write(JSON.stringify({settings:this.settingsCenter&&!this.approval?this.settingsCenter.view():null,palette,paletteIndex:this.paletteIndex||0,agentBusy:!!this.agentActive,transitionMs:transitionMs!==null&&transitionMs<1700?transitionMs:null,busySeconds:this.activity&&this.turnStarted?Math.floor((Date.now()-this.turnStarted)/1000):null,plan:Array.isArray(this.plan)?this.plan:null,interrupted:!!this.interrupted,cols:this.output.columns||120,rows:this.output.rows||40,cwd:require('./agent-turn.cjs').workspace(),draft:this.editor.text,cursor:rendererCursor(this.editor),messages:this.messages,scroll:this.scroll,mouseEvents,clearSelection,copySelection,busy:this.activity,details:this.details,blockExpanded:this.blockExpanded,usage:this.usage?.snapshot(),hud:this.hud||null,hudPosition:this.hudPosition||'left',theme:this.theme||'damar-ember',bannerMode:this.bannerMode||'flame',language:this.language==='id'?'id':'en',sidebarEnabled:this.sidebarEnabled!==false&&!(this.settingsCenter&&!this.approval),animationFrame:this.animationFrame,pick:this.pick?{kind:this.pick.kind||'command',title:typeof this.pick.title==='string'?this.pick.title.slice(0,60):null,choices:this.pick.choices,index:this.pick.index,returnToSettings:!!this.pick.returnToSettings}:null,notice:typeof this.notice==='string'?this.notice.slice(0,200):null,search:this.search?{query:this.search.query}:null,approval:this.approval?{...this.approval.binding,index:this.approval.index}:null})+'\n');
 }
 // Window title (design W1): spinner while busy, a blinking ✓ after a completed turn; written only when it changes.
 // Appended after a complete frame (never mid-frame), OSC 0 terminated with ST.
 titleSequence(){
  const blink=this.doneAt&&Date.now()-this.doneAt<6000;
  const title=this.activity?TITLE_SPINNER[this.animationFrame%10]+' DAMAR':blink&&Math.floor(this.animationFrame/7)%2?'✓ DAMAR':'DAMAR';
  if(title===this.title)return '';
  this.title=title;return '\x1b]0;'+title+'\x1b\\';
 }
 print(message){
  if(!this.messages)return;
  this.messages.push({role:'assistant',text:String(message).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'')});
   if(this.messages.length>200){this.messages.shift();this.blockExpanded={};this.clearSelection=true;}this.render();
 }
  onKey(text,key){
   if(key.name==='escape'&&key.native&&key.repeat)return;
   if(!this.activity&&!this.pick&&!this.approval&&!this.search&&this.selectionActive){
    if(key.ctrl&&key.name==='c'){this.copySelection=true;this.render();return;}
    if(key.name==='escape'){this.clearSelection=true;this.render();return;}
   }
   if(this.settingsCenter&&!this.approval){
    const center=this.settingsCenter;
    if(key.ctrl&&key.name==='c'){center.cancel();return;}
    Promise.resolve(center.key(text,key)).catch(()=>this.emit('inputError','SETTINGS_ACTION_FAILED'));return;
   }
   if(this.pick){
    if(key.name==='escape'||key.ctrl&&key.name==='c'){this.pick=null;this.render();return;}
    // Session picker: typed characters search titles/workspace/model/status; arrows, wheel and click navigate.
    if(this.pick.kind==='session'&&!['up','down','return','tab'].includes(key.name)){
     if(key.name==='backspace')this.pick.query=this.pick.query.slice(0,-1);
     else if(typeof text==='string'&&text.length===1&&text>=' '&&!key.ctrl&&!key.meta)this.pick.query=(this.pick.query+text).slice(0,40);
     else{this.render();return;}
     filterSessionPick(this.pick);this.render();return;
    }
    if(key.name==='up'||text==='k'){this.pick.index=Math.max(0,this.pick.index-1);this.render();return;}
    if(key.name==='down'||text==='j'){this.pick.index=Math.min(this.pick.choices.length-1,this.pick.index+1);this.render();return;}
     if(key.name==='return'||key.name==='tab'){
      if(this.pick.kind==='provider'||this.pick.kind==='model'){
       const pick=this.pick;this.pick=null;
       const value=pick.kind==='provider'?pick.ids?.[pick.index]:pick.choices[pick.index];
       if(typeof value!=='string'){this.render();return;}
       this.emit('line',pick.kind==='provider'?'connect '+value:'model use '+value);return;
      }
      if(this.pick.kind==='session'){
       const id=this.pick.ids[this.pick.index];
       if(typeof id!=='string'){this.render();return;}
       this.pick=null;this.render();this.emit('sessionPick',id);return;
      }
      if(this.pick.kind==='theme'){
       const selected=this.pick.choices[this.pick.index],returnToSettings=this.pick.returnToSettings===true;this.pick=null;
       try{require('./appearance.cjs').applyAppearance(this,{name:'themes',value:selected});if(returnToSettings)require('./appearance.cjs').openSettings(this);}
       catch{this.emit('inputError','UI_SETTINGS_SAVE_FAILED');}
      }else{this.editor.replace('/'+this.pick.choices[this.pick.index]+' ');this.pick=null;}
      this.render();return;
     }
   return;
  }
  if(this.approval?.agent){
   // Agent permission card: 1 Allow once, 2 Allow always this session (this exact request), 3 Deny (default).
   const choices=['once','session','deny'];
   if(key.ctrl&&key.name==='t'){this.details=!this.details;this.render();return;}
   if(key.name==='escape'||key.ctrl&&key.name==='c'){this.finishApproval('deny');return;}
   if(key.name==='up'||text==='k'){this.approval.index=Math.max(0,this.approval.index-1);this.render();return;}
   if(key.name==='down'||text==='j'){this.approval.index=Math.min(2,this.approval.index+1);this.render();return;}
   if(key.name==='return'){this.finishApproval(choices[this.approval.index]);return;}
   if(!key.ctrl&&!key.meta){const pick={'1':'once','2':'session','s':'session','S':'session','3':'deny','d':'deny','D':'deny','n':'deny','N':'deny'}[text];if(pick){this.finishApproval(pick);return;}}
   return;
  }
  if(this.approval){
   if(key.ctrl&&key.name==='t'){this.details=!this.details;this.render();return;}
   if(['escape'].includes(key.name)||key.ctrl&&key.name==='c'){this.finishApproval(false);return;}
   if(key.name==='up'||text==='k'){this.approval.index=Math.max(0,this.approval.index-1);this.render();return;}
   if(key.name==='down'||text==='j'){this.approval.index=Math.min(1,this.approval.index+1);this.render();return;}
   if(key.name==='return'){this.finishApproval(this.approval.index===0);return;}
   if(!key.ctrl&&!key.meta&&['1','a','A'].includes(text)){this.finishApproval(true);return;}
   if(!key.ctrl&&!key.meta&&['2','d','D','n','N'].includes(text)){this.finishApproval(false);return;}
   return;
  }
  if(key.ctrl&&key.name==='t'){this.details=!this.details;this.blockExpanded={};this.render();return;}
  if(key.name==='tab'&&!this.search&&!this.activity){
   const draft=this.editor.text;
   const items=this.paletteNow(),top=items[this.paletteIndex||0];
   if(top&&draft.length>1){this.editor.replace(top.cmd+' ');this.render();return;}
   if(/^\/?[a-z]*$/.test(draft)){
    const choices=commandChoices(this.readCommands||{},draft);
    if(choices.length===1)this.editor.replace('/'+choices[0]+' ');
    else if(choices.length)this.pick={choices,index:0};
    this.render();return;
   }
  }
  if(key.ctrl&&key.name==='home'){this.scroll=this.scrollLimit||0;this.render();return;}
  if(key.ctrl&&key.name==='end'){this.scroll=0;this.render();return;}
  if(['up','down'].includes(key.name)&&!key.ctrl){const items=this.paletteNow();if(items.length){this.paletteIndex=Math.min(items.length-1,Math.max(0,(this.paletteIndex||0)+(key.name==='down'?1:-1)));this.render();return;}}
  if(key.name==='up'&&!key.ctrl){this.scroll+=3;this.render();return;}
  if(key.name==='down'&&!key.ctrl){this.scroll=Math.max(0,this.scroll-3);this.render();return;}
  if(key.name==='pageup'){this.scroll+=Math.max(3,(this.output.rows||24)-8);this.render();return;}
  if(key.name==='pagedown'){this.scroll=Math.max(0,this.scroll-Math.max(3,(this.output.rows||24)-8));this.render();return;}
  // Original W5 uses Ctrl+Up/Down for history; plain arrows scroll the transcript.
  if(key.ctrl&&['up','down'].includes(key.name)){super.onKey(text,{...key,ctrl:false});return;}
  const submit=key.name==='return'&&!key.alt&&!key.meta&&!key.shift&&!this.search;
  if(submit&&this.messages){
   const partial=/^\/[a-z-]*$/.test(this.editor.text.trim())?this.paletteNow():[];
   const chosen=partial[this.paletteIndex||0];
   if(chosen&&(this.paletteIndex||!partial.some(m=>m.cmd===this.editor.text.trim())))this.editor.replace(chosen.cmd);
   if(!this.messages.length&&this.introActive&&this.bannerMode!=='static')this.transitionStart=Date.now();
   const line=this.editor.text,name=line.trim().replace(/^\//,'').split(/\s/)[0];
   // Structured commands echo as typed; free-text payloads (plan/revise/subagent run tasks) stay masked.
    const trimmed=line.trim(),freeText=/^\/?(plan|revise)\b|^\/?subagent\s+run\b/.test(trimmed);
    // A natural-language request for the agent (not a command word, not /-prefixed) is shown as the Owner typed it.
    const agentText=trimmed&&!trimmed.startsWith('/')&&name.toLowerCase()!=='sessions'&&!Object.hasOwn(this.readCommands||{},require('./command-registry.cjs').canonicalName(name.toLowerCase()));
    if(agentText)this.messages.push({role:'user',text:trimmed.slice(0,8000)});
    else this.messages.push({role:'user',text:!freeText&&/^\/?(\?|[a-z][a-z-]*)( [A-Za-z0-9._:\/@+-]{1,128}){0,3}$/.test(trimmed)?trimmed:'['+(/^(plan|approve|execute|verify|revoke|cancel|reconcile)$/.test(name)?name:'input')+' arguments hidden]'});
   // Base editor's transcript echo belongs to its line renderer, not the original W5 frame.
   super.onKey(text,key);
   this.render();return;
  }
  super.onKey(text,key);
 }
 close(){
   if(this.closed)return;
   this.native?.close();
  if(this.approval)this.finishApproval(false);
  clearTimeout(this.rendererDeadline);clearInterval(this.animation);super.close();this.protocol?.close();this.rendererLines?.destroy();this.renderer?.stdin.end();this.output.write('\x1b[?2026l\x1b]0;DAMAR\x07\x1b[?1049l\x1b[?25h');
  const child=this.renderer;if(child){const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},500);timer.unref();child.once('exit',()=>clearTimeout(timer));}
 }
 confirmOwner(binding){
  if(this.approval)return Promise.resolve(false);
  return new Promise(resolve=>{this.approval={binding,index:1,resolve};this.render();});
 }
 // Agent permission card (a pending card resolves as Deny if the input closes).
 confirmPermission(card){
  if(this.approval)return Promise.resolve('deny');
  return new Promise(resolve=>{this.approval={agent:true,binding:{agent:true,card},index:2,resolve};this.render();});
 }
 // Close an open agent permission card that was answered on another surface (Damar Notch); resolves as 'external'.
 dismissPermission(){const pending=this.approval;if(!pending?.agent)return;this.approval=null;pending.resolve('external');this.render();}
 finishApproval(allowed){const pending=this.approval;if(!pending)return;this.approval=null;pending.resolve(pending.agent&&typeof allowed!=='string'?'deny':allowed);this.render();}
}
module.exports={W5Input,filterSessionPick};
