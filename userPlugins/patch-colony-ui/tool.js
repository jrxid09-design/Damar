// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchColonyUiTool {

    constructor() {
        this.name = "patchColonyUi";
        this.description = "Menambahkan UI chat colony ke dashboard utama (CommandCenter index.html): tombol COLONY floating + panel chat dengan kotak ketik yang nyaman (auto-grow, tidak gepeng), mengirim ke /api/colony/chat mode all sehingga Viel, NODEK-01, dan Nyx menanggapi dan saling merespon.";
        this.parameters = {
                "dummy": {
                        "description": "tidak dipakai",
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/index.html';
        let c = fs.readFileSync(p, 'utf8');

        const css = `
        /* ==== COLONY CHAT ==== */
        #colony-fab{position:fixed;right:24px;bottom:24px;z-index:100;font-family:'Cinzel',serif;background:linear-gradient(135deg,var(--gold-dim),var(--gold));color:#0a0012;border:none;padding:14px 24px;font-size:12px;letter-spacing:.2em;font-weight:700;cursor:pointer;box-shadow:0 6px 24px rgba(255,215,0,.4)}
        #colony-fab:hover{box-shadow:0 8px 30px rgba(255,215,0,.6)}
        #colony-panel{position:fixed;right:24px;bottom:92px;width:420px;max-width:calc(100vw - 40px);height:540px;max-height:calc(100vh - 140px);background:rgba(16,0,34,.97);border:1px solid var(--gold-dim);z-index:99;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6)}
        .colony-hidden{display:none !important}
        #colony-head{padding:12px 16px;font-family:'Cinzel',serif;font-size:11px;letter-spacing:.25em;color:var(--gold);border-bottom:1px solid var(--gold-dim);background:rgba(26,0,51,.6);display:flex;justify-content:space-between;align-items:center}
        #colony-close{cursor:pointer;color:var(--gold-dim);font-size:14px;background:none;border:none}
        #colony-close:hover{color:var(--gold)}
        #colony-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
        .msg{max-width:88%;padding:9px 12px;font-size:13px;line-height:1.55;font-family:'Playfair Display',serif}
        .msg .who{display:block;font-family:'Cinzel',serif;font-size:9px;letter-spacing:.15em;color:var(--gold-dim);margin-bottom:3px;font-weight:700}
        .msg.user{align-self:flex-end;background:rgba(255,215,0,.14);border:1px solid rgba(255,215,0,.35);border-radius:10px 2px 10px 10px}
        .msg.ai{align-self:flex-start;background:rgba(26,0,51,.65);border:1px solid rgba(255,215,0,.14);border-radius:2px 10px 10px 10px}
        #colony-composer{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--gold-dim);align-items:flex-end;background:rgba(16,0,34,.92)}
        #colony-input{flex:1;min-height:46px;max-height:120px;height:46px;resize:none;background:rgba(26,0,51,.7);border:1px solid var(--gold-dim);color:var(--text-cream);font-family:'Playfair Display',serif;font-size:13px;line-height:1.5;padding:10px 12px;outline:none;box-sizing:border-box}
        #colony-input:focus{border-color:var(--gold)}
        #colony-input::placeholder{color:var(--text-dim)}
        #colony-send{height:46px;padding:0 18px;background:var(--gold);color:#0a0012;border:none;font-family:'Cinzel',serif;font-size:11px;letter-spacing:.15em;font-weight:700;cursor:pointer}
        #colony-send:disabled{opacity:.5;cursor:not-allowed}
        .typing{color:var(--gold-dim);font-style:italic;font-size:12px;padding:4px;align-self:flex-start}
        `;

        const html = `
        <!-- COLONY CHAT -->
        <button id="colony-fab">COLONY</button>
        <div id="colony-panel" class="colony-hidden">
          <div id="colony-head"><span>KERAJAAN &middot; NGOPI BERSAMA</span><button id="colony-close">&times;</button></div>
          <div id="colony-body"><div class="typing">Kirim pesan, dan seluruh koloni (Viel, NODEK-01, Nyx) akan menanggapimu serta saling merespon.</div></div>
          <div id="colony-composer">
            <textarea id="colony-input" placeholder="Kirim pesan ke koloni... (Enter = kirim)"></textarea>
            <button id="colony-send">KIRIM</button>
          </div>
        </div>
        <script>
        (function(){
          var fab=document.getElementById('colony-fab'),panel=document.getElementById('colony-panel'),
              bd=document.getElementById('colony-body'),inp=document.getElementById('colony-input'),snd=document.getElementById('colony-send');
          document.getElementById('colony-close').addEventListener('click',function(){panel.classList.add('colony-hidden')});
          fab.addEventListener('click',function(){panel.classList.toggle('colony-hidden')});
          function add(from,text,isUser){
            var d=document.createElement('div');d.className='msg '+(isUser?'user':'ai');
            var w=document.createElement('span');w.className='who';w.textContent=isUser?'KAMU':(from||'KOLONI');
            var t=document.createElement('span');t.textContent=text;d.appendChild(w);d.appendChild(t);bd.appendChild(d);bd.scrollTop=bd.scrollHeight;
          }
          function typing(on){
            var t=document.getElementById('c-typing');if(!t){t=document.createElement('div');t.id='c-typing';t.className='typing';bd.appendChild(t);}
            t.textContent=on?'Koloni sedang berpikir...':'';
          }
          function send(){
            var m=inp.value.trim();if(!m)return;add('',m,true);inp.value='';inp.style.height='46px';snd.disabled=true;typing(true);
            fetch('/api/colony/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:m,all:true})})
              .then(function(r){return r.json()})
              .then(function(j){
                (j.transcript||[]).forEach(function(x){add(x.from,x.text,false)});
                if(!j.transcript||!j.transcript.length)add('SISTEM','Tidak ada yang merespons. Pastikan koloni hidup (Viel/NODEK-01/Nyx).',false);
              })
              .catch(function(e){add('SISTEM','Gagal menghubungi koloni: '+e.message,false);})
              .finally(function(){typing(false);snd.disabled=false;});
          }
          snd.addEventListener('click',send);
          inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
          inp.addEventListener('input',function(){inp.style.height='auto';inp.style.height=Math.min(120,Math.max(46,inp.scrollHeight))+'px';});
        })();
        </script>
        `;

        // insert CSS before </style>
        if (c.indexOf('/* ==== COLONY CHAT ==== */') !== -1) return { ok: false, note: 'already patched' };
        const styleClose = c.lastIndexOf('</style>');
        if (styleClose === -1) return { ok: false, note: 'no style close' };
        c = c.slice(0, styleClose) + css + '\n' + c.slice(styleClose);
        // insert HTML before </body>
        const bodyClose = c.lastIndexOf('</body>');
        if (bodyClose === -1) return { ok: false, note: 'no body close' };
        c = c.slice(0, bodyClose) + html + '\n' + c.slice(bodyClose);
        fs.writeFileSync(p, c, 'utf8');
        return { ok: true, note: 'patched' };
    }

}

module.exports = [ new PatchColonyUiTool() ];
