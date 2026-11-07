// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchDashboardLiveTool {

    constructor() {
        this.name = "patchDashboardLive";
        this.description = "Menambahkan polling /api/colony/stream ke panel chat colony dashboard agar menampilkan percakapan otonom secara live.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/index.html';
        let src = fs.readFileSync(p, 'utf8');

        // 1) Tambah seenIds setelah deklarasi var
        const decMark = 'var fab=document.getElementById(\'colony-fab\'),panel=document.getElementById(\'colony-panel\'),';
        if (!src.includes('var seenIds')) {
          src = src.replace(decMark, 'var seenIds = {};\n          ' + decMark);
        }

        // 2) Modifikasi transcript forEach agar menandai seenIds
        const tMark = '(j.transcript||[]).forEach(function(x){add(x.from,x.text,false)});';
        const tRep = '(j.transcript||[]).forEach(function(x){var k=x.from+\'|\'+x.text;if(!seenIds[k]){seenIds[k]=true;add(x.from,x.text,false);}});';
        if (src.includes(tMark)) {
          src = src.replace(tMark, tRep);
        }

        // 3) Sisipkan polling stream sebelum akhir IIFE
        const pollMark = 'inp.addEventListener(\'input\',function(){inp.style.height=\'auto\';inp.style.height=Math.min(120,Math.max(46,inp.scrollHeight))+\'px\';});';
        const pollBlock = pollMark + '\n          function pollStream(){fetch(\'/api/colony/stream\').then(function(r){return r.json()}).then(function(j){(j.log||[]).forEach(function(x){var k=x.from+\'|\'+x.text;if(!seenIds[k]){seenIds[k]=true;add(x.from,x.text,false);}});}).catch(function(){});}\n          setInterval(pollStream,6000);\n          pollStream();';
        if (src.includes(pollMark) && !src.includes('pollStream')) {
          src = src.replace(pollMark, pollBlock);
        }

        fs.writeFileSync(p, src);
        return { ok: true, bytes: src.length, hasSeen: src.includes('var seenIds'), hasPoll: src.includes('pollStream') };
    }

}

module.exports = [ new PatchDashboardLiveTool() ];
