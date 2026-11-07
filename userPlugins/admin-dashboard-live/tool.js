// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  constructor(){
    this.name='BUILD_ADMIN_DASHBOARD_LIVE';
    this.description='Bangun ulang dashboard Command Center menjadi tampilan admin yang hidup dan ringan.';
    this.parameters={
      rootPath:{type:'string',description:'Path folder Command Center',required:true},
      endpoint:{type:'string',description:'Endpoint status yang di-poll',required:false}
    };
  }
  async execute(args){
    const fs = require('fs');
    const path = require('path');
    const root = args.rootPath || 'C:\\AetherGenesis\\CommandCenter';
    const ep = args.endpoint || '/api/all';
    const html = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Command Center - Admin</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e6e8ee;padding:20px;min-height:100vh}h1{font-size:20px;margin-bottom:4px;letter-spacing:.5px}.sub{color:#8b90a0;font-size:12px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.card{background:#181b24;border:1px solid #242836;border-radius:10px;padding:14px;transition:.2s}.card h3{font-size:13px;color:#8b90a0;font-weight:500;margin-bottom:8px}.status{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600}.dot{width:9px;height:9px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80}.dot.off{background:#f87171;box-shadow:0 0 6px #f87171}.meta{font-size:11px;color:#5a6070;margin-top:8px;white-space:pre-wrap}#bar{position:fixed;bottom:0;left:0;right:0;height:3px;background:#181b24}#bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4ade80,#22d3ee);transition:width .5s}</style></head><body><h1>Command Center</h1><div class="sub" id="clock">--</div><div class="grid" id="grid">Memuat status...</div><div id="bar"><i></i></div><script>const EP='${ep}';const grid=document.getElementById('grid');const clock=document.getElementById('clock');const bar=document.querySelector('#bar i');function tick(){clock.textContent=new Date().toLocaleString('id-ID');}function render(data){if(!data||typeof data!=='object'){grid.innerHTML='<div class="card"><h3>Error</h3><span class="meta">Data tidak valid</span></div>';return;}const keys=Object.keys(data);grid.innerHTML=keys.map(k=>{const v=data[k];const on=v===true||v==='online'||v===1||(typeof v==='object'&&v&&v.online===true);const st=on?'':' off';const meta=typeof v==='object'?JSON.stringify(v,null,1):String(v);return '<div class="card"><h3>'+k+'</h3><span class="status"><span class="dot'+st+'"></span>'+(on?'ONLINE':'OFFLINE')+'</span><div class="meta">'+meta+'</div></div>';}).join('');}async function poll(){try{const r=await fetch(EP);const d=await r.json();if(d&&d.services)render(d.services);else render(d);bar.style.width='100%';setTimeout(()=>bar.style.width='0',600);}catch(e){grid.innerHTML='<div class="card"><h3>Koneksi gagal</h3><span class="meta">'+e.message+'</span></div>';}}setInterval(tick,1000);tick();poll();setInterval(poll,4000);</script></body></html>`;
    const file = path.join(root, 'index.html');
    try {
      fs.writeFileSync(file, html, 'utf8');
      return {ok:true, hasil:'index.html ditulis ulang: '+file+' ('+Buffer.byteLength(html)+' byte)', path:file};
    } catch(e){ return {ok:false, error:String(e)}; }
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "BUILDADMINDASHBOARDLIVE";
        this.description = "Membangun ulang dashboard Command Center (port 8650) menjadi tampilan admin yang hidup dan ringan: menulis ulang index.html dengan panel status realtime, kartu layanan dengan indikator ONLINE/OFFLINE, polling ringan ke endpoint status tiap 4 detik, jam berjalan, dan progress bar denyut — semua tanpa dependensi eksternal (HTML/CSS/JS murni).";
        this.parameters = {
    rootPath: {"type":"string","description":"Path folder Command Center (mis. C:\\AetherGenesis\\CommandCenter) tempat index.html ditulis ulang.","required":true},
    endpoint: {"type":"string","description":"Endpoint status yang di-poll (mis. /api/all atau /api/colony/status). Default /api/all.","required":false}
        };
    }
    // Kontrak plugin: execute(context, params).
    // Pilih sumber args yang benar: params utama; context
    // kadang membawa args saat pemanggil legacy.
    async execute(context, params) {
        const args = (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length)
            ? params
            : (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length)
                ? context
                : {};
        return this._impl.execute(args);
    }
}
module.exports = [new Tool()];
