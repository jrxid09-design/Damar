# Damar & Pandawa

Damar bukan satu model — ia bisa mendelegasikan tugas ke **Pandawa**,
kolektif lima spesialis miliknya, lalu mengoordinasikan hasilnya.

```
                       Damar
            identitas & kognisi kanonik
                         │
                         ▼
                      Pandawa
                         │
   ┌────────────┬─────────┼─────────┬────────────┐
   ▼            ▼         ▼         ▼            ▼
Puntadewa   Werkudara   Janaka    Nakula      Sadewa
strategi &  keamanan &  rekayasa  data, stat  riset, bukti
sintesis &  infrastruk  & koding  & numerik   & verifikasi
arbitrase   & resiliensi& debug    & RF/spasial& provenance
```

## Agent

Peran eksekutable diproyeksikan dari satu sumber kanonik
(`pandawaIdentity.ROLE_PROFILES`) — tidak ada salinan kedua.

| Agent | Peran kanonik |
|---|---|
| **damar** | Otak LLM lokal: menalar, menulis, menghitung, memakai memori & tool internal. Default untuk berpikir. |
| **puntadewa** | Strategi, sintesis, arbitrase, perencanaan: dekomposisi tujuan, rencana bertingkat, sintesis lintas-pandangan, arbitrase konflik prioritas, prioritisasi. |
| **werkudara** | Keamanan, infrastruktur, resiliensi, telaah adversarial: pemodelan ancaman, telaah izin, pengerasan infrastruktur, uji adversarial, uji ketahanan, analisis insiden. |
| **janaka** | Rekayasa, koding, arsitektur, implementasi, debugging: rancang arsitektur, bangun/refactor perangkat lunak, debug, uji, kelola perubahan kode. |
| **nakula** | Data, statistik, numerik, RF, analitik spasial: metrik, model statistik, analisis numerik, telaah sinyal/RF, analisis spasial-visual. |
| **sadewa** | Riset, bukti, verifikasi, provenance: penelusuran sumber, pengumpulan bukti, verifikasi klaim, provenance artefak, klasifikasi epistemik. |

Semua agent hidup di runtime Damar yang sama — selalu online selama
daemon berjalan. Sintesis akhir ke pengguna tetap **Damar**; Pandawa
tidak tampil sebagai lima asisten terpisah.

## Batas kewenangan Pandawa

Pandawa adalah unit spesialis, **bukan akar otoritas**. Tidak ada
anggota yang mendapat kewenangan tambahan karena perannya:

| Hukum | Artinya |
|---|---|
| `PLAN != AUTHORITY` | Puntadewa menyusun rencana & mengarbitrase; rencana/arbitrase tidak memberi izin. |
| `EVIDENCE != TRUTH` | Sadewa mengumpulkan bukti & memverifikasi; temuan wajib membawa sumber, provenance & tingkat keyakinan. |
| `SECURITY != BYPASS` | Werkudara meninjau keamanan; ia tetap tunduk pada Authority Gate dan kill switch. |
| `ENGINEERING != FREE EXEC` | Janaka merekayasa; setiap aksi nyata tetap melewati Actuation Fabric. |
| `ANALYTICS != FREE EXEC` | Nakula menganalisis data; temuan analitik bukan izin aksi nyata. |
| `MODEL CLAIM != AUTHORITY` | Model menentukan CARA berpikir, bukan SIAPA Damar. |
| `CHANNEL != AUTHORITY` | Kanal memilih konteks, bukan hak. |

Secara teknis: `AgentHub.run()` menurunkan peran worker lewat
`delegatedRoleOf(exec)` — worker **mewarisi** otoritas delegator dan
tidak pernah menaikkannya — lalu `assertRestrictionsPreserved()`
gagal-keras bila `capabilitySet` hilang di transit. Seleksi tool juga
disaring oleh `capabilitySet` yang sama, sehingga worker terbatas tidak
pernah *melihat* kandidat di luar setnya.

Nama kolektif lama masih dikenali sebagai alias yang DEPRECATED
(`vanta→janaka`, `cipher→werkudara`, `atlas→puntadewa`,
`forge|nexus|sera|echo|lumen→nakula`, `mira|pulse→sadewa`,
`aether→damar`); alias tidak pernah muncul sebagai agent kedua di
`agents()`. Lihat `docs/architecture/DAMAR-IDENTITY-MIGRATION.md`.

## Cara kerja orkestrasi

Permintaan kompleks tidak dijawab satu tembakan:

```
1. RENCANA  — Damar-LLM memecah tugas jadi langkah, tiap langkah
              ditugaskan ke agent paling cocok (output JSON).
2. EKSEKUSI — tiap langkah dijalankan berurutan; hasil langkah
              sebelumnya diteruskan sebagai konteks.
3. SINTESIS — Damar-LLM merangkum hasil jadi jawaban akhir.
```

Setiap tahap memancarkan event (planning → plan → step:start →
step:done → final), jadi prosesnya terlihat langsung di Console
(halaman **Agents**) — bukan sekadar hasil akhir.

Kalau permintaannya sederhana, perencana cukup membuat satu langkah
`damar` dan jawabannya langsung dipakai.

## Antarmuka

- **Console → Agents**: kartu kesiapan tiap agent + konsol orkestrasi
  dengan langkah-langkah tampil realtime.
- **API**:
  | Method | Endpoint | Guna |
  |---|---|---|
  | GET | `/console/agents` | Kesiapan tiap agent |
  | POST | `/console/orchestrate` | Jalankan orkestrasi (SSE: planning/plan/step/final) |

## Catatan

- Kualitas rencana bergantung pada model AI aktif. Untuk hasil bagus,
  pakai model kuat (model lokal yang mumpuni atau platform berbayar
  lewat Settings).
- Pandawa memakai tool sesuai topiknya (profil per anggota) — lihat
  `src/agent/agentTools.js`.
