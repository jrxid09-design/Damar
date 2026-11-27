# MCP Produktivitas — Katalog & Panduan Connect

Suite MCP produktivitas Damar: layanan eksternal dan lokal yang
terhubung **sekali** oleh pengguna (login/consent), setelah itu tool-nya
hidup di Damar. Semua tool berjalan sebagai server MCP stdio yang
di-bridge oleh `McpClientManager` Damar sendiri, sehingga setiap
panggilan tool melewati jalur kanonis yang sama seperti tool MCP lain:
**Manager → Authority Gate**. Tidak ada jalur pintas.

- Kode: `src/mcp/productivity/` (registry, OAuth, vault token store,
  connect service, 10 implementasi server)
- Proses server: `scripts/mcp-productivity-server.js <serverId>`
- Addon Blender: `tools/blender-mcp/damar_blender_addon.py`
- Panel Dashboard: view **Produktivitas (MCP)** di Control Dashboard
  (`apps/desktop/src/control/views/mcp-productivity.js`), API di
  `/api/v1/console/mcp/productivity/*`
- Contoh konfigurasi non-rahasia: `configs/mcp-productivity.json.example`

## Prinsip keamanan

- **Token hanya di Secret Vault.** Access/refresh token dan client
  secret disimpan sebagai secret terenkripsi (AES-256-GCM) lewat
  `src/runtime/vault`. File status hanya menyimpan *reference string*
  (`secretref:v1:…`); status API hanya menampilkan metadata (label
  akun, masa berlaku) — tidak pernah nilai token.
- **Tier tool → Authority Gate.** Setiap tool dideklarasikan `read`
  atau `write` di registry. Semua tool `write` (kirim/upload/hapus/
  putar/ubah) terdaftar eksplisit sebagai destruktif di
  `riskCatalog`, jadi diperlakukan sebagai tier approval oleh gerbang —
  sama seperti tool destruktif lain di Damar.
- **Lane 2 tidak berubah.** Grant-proof MCP (ownerGrant/managerAdapter)
  tetap apa adanya; suite ini adalah *klien* MCP biasa di Lane 1.

## Kejujuran OAuth (baca sebelum connect)

Damar adalah aplikasi **lokal dan open source tanpa backend cloud**.
Konsekuensinya: tidak ada "client OAuth Damar" pusat yang bisa dipakai
semua pengguna. Pola yang bisa dikirim (shippable) adalah:

1. Pengguna membuat **client OAuth miliknya sendiri** sekali saja di
   konsol penyedia (Google Cloud Console, Azure, Notion, …) — panel
   Dashboard menampilkan petunjuk per penyedia, termasuk redirect URI
   persis yang harus didaftarkan:
   `http://127.0.0.1:<port-core>/api/v1/console/mcp/oauth/<provider>/callback`.
2. Pengguna menempel client id + secret di kartu server pada Dashboard.
   Secret masuk vault terenkripsi dan tidak pernah ditampilkan lagi.
3. Setelah itu **connect = satu klik**: browser membuka halaman consent
   penyedia, token kembali lewat callback loopback, tersimpan di vault,
   dan tool langsung hidup. Refresh token berjalan otomatis; disconnect
   mencabut token di penyedia (bila penyedia mendukung revoke) dan
   menghapus token lokal.

## Katalog server

| ID | Nama | Auth | Tool | Kedalaman |
| --- | --- | --- | --- | --- |
| `google-workspace` | Google Workspace (Gmail · Drive · Calendar) | OAuth 2.0 | 13 | Penuh — satu consent untuk 3 layanan; tiap layanan bisa dimatikan (scope & tool ikut hilang) |
| `microsoft-365` | Microsoft 365 (Outlook · OneDrive · Calendar) | OAuth 2.0 | 8 | Connect penuh + baca inti + tulis utama (kirim email, upload, buat event). Microsoft tidak punya endpoint revoke publik — disconnect menghapus token lokal |
| `notion` | Notion | OAuth 2.0 | 6 | Penuh — search, baca page, query database, buat page, append teks |
| `slack` | Slack | OAuth 2.0 | 3 | Connect penuh — list channel, riwayat, kirim pesan (approval) |
| `github` | GitHub | OAuth 2.0 | 7 | Penuh — repo, issue, PR; buat issue & komentar (approval) |
| `spotify` | Spotify | OAuth 2.0 | 7 | Connect penuh — status playback, playlist, kontrol putar (approval) |
| `todoist` | Todoist | OAuth 2.0 | 4 | Connect penuh — list/buat/selesaikan/hapus tugas |
| `blender` | Blender (lokal) | Lokal | 5 | Bridge socket ke addon di Blender lokal; perintah bertipe saja (tanpa eksekusi kode arbitrer) |
| `filesystem` | Filesystem (folder izin) | Lokal | 5 | Baca/tulis hanya di dalam folder yang diberikan pengguna; lolos symlink & traversal ditolak |
| `web` | Web (fetch & search) | Tanpa login | 2 | Fetch URL publik → teks terbaca; pencarian web. Penjaga SSRF: skema non-http(s), host lokal, dan IP privat/loopback ditolak (termasuk hasil DNS) |

Daftar tool persis per server ada di `src/mcp/productivity/registry.js`
(sumber kebenaran tunggal — registry yang sama dipakai server runtime,
seeding `configs/mcp.json`, panel Dashboard, dan pemetaan risiko).

## Cara mengaktifkan

1. Buka Control Dashboard → **Produktivitas (MCP)**.
2. Untuk server OAuth: buat client di konsol penyedia (petunjuk ada di
   kartu server), tempel client id/secret → **Connect** → setujui di
   browser.
3. Untuk Filesystem: isi daftar folder izin → simpan.
4. Untuk Blender: pasang addon dari `tools/blender-mcp/`, aktifkan,
   lalu **Start Server** di panel *DAMAR MCP* pada sidebar 3D View.
5. Klik **Daftarkan semua server ke MCP** (menulis entri stdio ke
   `configs/mcp.json` lewat config store resmi), lalu muat ulang Core —
   tool muncul sebagai `mcp__<server>__<tool>` dan siap dipakai model
   lewat Authority Gate.

## Titik ekstensi (server masa depan)

Menambah server baru cukup:

1. Tambah entri di `registry.js` (id, nama, auth, provider OAuth bila
   ada, daftar tool + tier).
2. Tulis `servers/<id>.js` yang mengekspor `createServer(ctx)` →
   `{ id, tools: { <nama>: { definition, handler } } }`, memakai
   `ctx.tokenProvider` untuk API ber-OAuth atau `ctx.state` untuk
   konfigurasi lokal.
3. Bila tool-nya `write`, namanya otomatis wajib masuk daftar
   destruktif `riskCatalog` (tes registry menegakkan pemetaan ini).
4. Framework OAuth generik (PKCE, consent, refresh, revoke, vault)
   dipakai ulang apa adanya — provider baru hanya butuh URL
   authorize/token/revoke + scope di registry.
