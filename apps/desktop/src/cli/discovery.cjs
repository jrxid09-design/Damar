'use strict';
const {definitions}=require('./commands.cjs');
function commandChoices(readCommands,query=''){
 if(typeof query!=='string'||query.length>128)return [];
 const names=[...Object.keys(readCommands),...Object.keys(definitions)];
  return [...new Set(names)].map(name=>name==='supervisor'?'supervisor status':['mcp','plugins','skills'].includes(name)?name+' list':name).filter(name=>name.startsWith(query.replace(/^\//,''))).sort();
}
// Command palette (design: "╭─ COMMAND PALETTE (Tab complete · Enter run)", max 6 prefix matches, first row marked).
// The design's 31 commands, each described by what THIS build really does; unavailable ones say so.
const PALETTE=[
 ['/help','Tampilkan semua command & pintasan keyboard','Show all commands & keyboard shortcuts'],
 ['/settings','Buka panel pengaturan lengkap Damar CLI','Open the full Damar CLI settings panel'],
 ['/connect','Pilih provider AI (fixture offline atau live dengan model grant)','Choose the AI provider (offline fixture, or live with a model grant)'],
 ['/model','Pilih atau ganti Model ID aktif','Choose or change the active model ID'],
 ['/permission','Profil otonomi: ask | workspace | full | read','Autonomy profile: ask | workspace | full | read'],
 ['/plan','Susun plan terikat di Core (persetujuan Owner)','Create a bounded Core plan (Owner approval)'],
 ['/review','Code review workspace oleh agen (baca saja)','Agent code review of the workspace (read-only)'],
 ['/commit','Belum tersedia: tidak ada izin git di build ini','Not available: no git authority in this build',false],
 ['/cost','Pemakaian token sesi dari bukti Core','Session token usage from Core receipts'],
 ['/context','Inspeksi context window Core','Inspect the Core context window'],
 ['/compact','Belum tersedia: Core meringkas konteks otomatis','Not available: Core trims context automatically',false],
 ['/memory','Memori proyek workspace ini (add / forget; stats = memori Core)','Project memory of this workspace (add / forget; stats = Core memory)'],
 ['/agents','Kesehatan sub-agent Pandawa','Pandawa sub-agent health'],
 ['/subagent','Jalankan, daftar atau batalkan run Pandawa','Run, list or cancel Pandawa runs'],
 ['/discuss','Tim Pandawa berdiskusi; DAMAR memberi keputusan','The Pandawa team debates a topic; DAMAR decides'],
 ['/delegate','Bagi subtugas ke anggota Pandawa secara paralel','Split subtasks across Pandawa members in parallel'],
 ['/team','Anggota Pandawa dan model yang dipakai','Pandawa members and the model each uses'],
 ['/skills','Katalog skill (belum tersedia di Core ini)','Skills catalog (not available in this Core)',false],
 ['/mcp','Status server MCP & tool eksternal','MCP servers & external tools'],
 ['/plugins','Daftar plugin aktif','Active plugins'],
 ['/sandbox','Batas workspace & kebijakan perintah','Workspace boundary & command policy'],
 ['/add-dir','Izinkan folder tambahan untuk agen (Core settings)','Authorize an extra folder for the agent (Core settings)'],
 ['/diff','Perubahan file oleh Damar di sesi ini','Files changed by Damar in this session'],
 ['/undo','Batalkan perubahan file giliran terakhir (dengan izin)','Undo the last turn\'s file changes (with approval)'],
 ['/redo','Terapkan ulang perubahan yang baru di-undo','Re-apply the change you just undid'],
 ['/checkpoints','Daftar perubahan file Damar di sesi ini','List Damar\'s file changes in this session'],
 ['/continue','Lanjutkan pekerjaan yang terputus','Continue interrupted work'],
 ['/sessions','Pilih & lanjutkan sesi tersimpan','Choose & resume a saved session'],
 ['/export','Ekspor transkrip sesi ke Markdown (profil privat)','Export the session transcript to Markdown (private profile)'],
 ['/themes','Ganti tema warna TUI','Change the TUI colour theme'],
 ['/banner','Toggle animasi api Damar (flame | static)','Toggle the Damar flame animation (flame | static)'],
 ['/details','Toggle expand/collapse diff & output (Ctrl+T)','Expand/collapse diffs & output (Ctrl+T)'],
 ['/sidebar','Tampilkan atau sembunyikan panel konteks','Show or hide the context panel'],
 ['/doctor','Diagnostik sistem & koneksi','System & connection diagnostics'],
 ['/reload','Muat ulang preferensi tampilan profil','Reload saved profile appearance preferences'],
 ['/restart','Restart Core dengan aman, lalu CLI melanjutkan sesi yang sama','Safely restart Core, then relaunch the CLI in the same session'],
 ['/clear','Bersihkan layar (sesi tetap tersimpan)','Clear the screen (the session stays saved)'],
];
function paletteMatches(draft,language='en'){
 if(typeof draft!=='string'||!draft.startsWith('/')||/\s/.test(draft)||draft.length>32)return [];
 const q=draft.toLowerCase();
 return PALETTE.filter(([cmd])=>cmd.startsWith(q)).slice(0,6).map(([cmd,id,en,available=true])=>({cmd,desc:language==='en'?en:id,available}));
}
module.exports={commandChoices,paletteMatches,PALETTE};
