# ADR-007 — Satu rantai keselamatan untuk kedua jalur tool

**Tanggal:** 2026-08-12
**Status:** Diterima
**Terkait:** §33, §34, §37, §38, §46, §140; Konstitusi Pasal 4

---

## Konteks

Rantai keselamatan (otorisasi risiko → rem kebuntuan → batas jalur →
verifikasi) ditulis di dalam `ToolRegistry.execute`, dengan asumsi ia
adalah chokepoint tunggal. Komentar di `ToolExecutor` bahkan menyatakan
hal itu secara eksplisit.

Asumsi tersebut salah. Aether punya **dua registry tool**:

| Registry | Isi | Jalur eksekusi |
|---|---|---|
| `core/tools/ToolRegistry` | 80 tool plugin | `ToolRegistry.execute` — rantai penuh |
| `ai/tools/AIToolRegistry` | tool asli model | `ToolExecutor` → `tool.execute()` langsung |

Tool plugin memang dijembatani ke registry AI dan tetap melewati
registry inti. Tetapi tool asli model — memori, rumah, WhatsApp,
terminal, dan coding — didaftarkan langsung dan **tidak pernah**
menyentuh registry inti.

Akibatnya, saat model memanggilnya:

- `riskPolicy` tidak berlaku
- `loopGuard` tidak berlaku
- `pathPolicy` tidak berlaku
- `VerificationEngine` tidak berlaku

Hanya kill switch yang menjaga. `terminal_run`, `code_commit`,
`code_rollback`, dan `home_control` berjalan tanpa otorisasi apa pun.

Diperburuk oleh dua cacat katalog risiko:

1. **Pola nama mencocokkan substring.** `get` ada di dalam `forget`,
   sehingga `memory_forget` terbaca **L0** — sekelas dengan menanyakan
   jam.
2. **Tak satu pun tool asli model terdaftar.** Seluruhnya jatuh ke
   default pesimistis L4, termasuk tool baca murni seperti
   `code_hover` dan `home_state`.

Cacat kedua tidak terasa selama rantai memang tidak ditegakkan.
Begitu ditegakkan, keduanya langsung berakibat.

---

## Keputusan

**1. Rantai diangkat ke `src/core/safety/toolGuard.js`, dipakai kedua jalur.**

Menyalin rantai ke jalur kedua akan menghasilkan dua definisi yang
pasti menyimpang. Satu modul, dua pemanggil.

**2. Tool jembatan dilewati di `ToolExecutor`, bukan dijaga dua kali.**

Penjagaan ganda membuat `loopGuard` menghitung satu panggilan sebagai
dua — tool yang sah akan tertahan pada panggilan ke-3, bukan ke-5.
`bridgePluginTools()` menandai setiap jembatan dengan id registry
intinya; registry itulah yang menjaganya.

**3. Pola risiko memakai batas kata.**

Cocok di awal id, sesudah pemisah (`_`, `.`, `-`), atau sebagai punuk
camelCase. `readFile` dan `runCommand` tetap terbaca; `forget` dan
`budget` tidak lagi salah dibaca sebagai `get`.

**4. 47 tool asli model diklasifikasikan eksplisit.**

**5. `terminal_run` = L5, sama dengan `run-command.runCommand`.**

Keduanya menjalankan perintah sembarang. Kemampuan yang sama tidak
boleh punya dua tingkat izin hanya karena terdaftar di registry
berbeda.

**6. Panel keamanan menghitung kedua registry.**

Sebelumnya melaporkan 80 tool padahal 105 kini diatur — dan pemilik
tidak akan menemukan `terminal_run` saat hendak memberi izin.

---

## Konsekuensi

### Yang berubah bagi pemilik

`terminal_run` **kini diblokir pada ambang bawaan L5.** Sebelumnya
model dapat menjalankan perintah sembarang tanpa izin.

Terbukti pada daemon yang berjalan: model diminta menyebutkan jam,
memilih `terminal_run`, ditolak, lalu melaporkannya kepada pengguna
alih-alih gagal diam-diam.

Untuk mengizinkannya sekali pakai:

```bash
curl -X POST http://localhost:3000/api/v1/console/safety/authorize -H "Authorization: Bearer $AETHER_TOKEN" -H "Content-Type: application/json" -d "{\"tool\":\"terminal_run\",\"ttlSeconds\":300,\"uses\":1}"
```

Atau lewat Panel Keamanan di Console.

### Yang tidak berubah

Alur yang sedang dipakai tetap jalan (§277). Ambang bawaan tetap L5,
sehingga hanya 6 tool destruktif yang diblokir. Tool baca murni yang
tadinya salah dibaca L4 justru menjadi lebih longgar dan tepat.

Diverifikasi langsung pada daemon: permintaan yang memakai tool L0
dijawab normal.

### Risiko tersisa

- Klasifikasi 47 tool baru ditetapkan dari deskripsi dan pembacaan
  kode, bukan dari pengamatan efek sampingnya. Yang keliru akan
  terlihat sebagai izin yang terasa salah tempat, bukan sebagai
  kegagalan diam-diam.
- Tool coding hanya terdaftar lewat `refreshTools()`, bukan saat boot.
  Panel karenanya melaporkan 105, bukan 136 — jumlah yang benar untuk
  keadaan saat itu, tetapi berubah setelah refresh.
