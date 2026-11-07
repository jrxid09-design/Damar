# Damar ToolForge — Damar menambah kemampuannya sendiri

Damar bisa membuat tool/plugin baru — lewat percakapan maupun
manual — lalu langsung memakainya tanpa restart daemon.

## Lewat percakapan

Cukup minta:

> "Buatkan tool untuk cek ping ke sebuah host."

Damar menyusun kode, menyimpannya sebagai **draft** (belum aktif),
lalu menjelaskan apa yang dilakukan tool + peringatan risiko. Setelah
kamu setujui ("ya, aktifkan"), tool langsung bisa dipanggil.

Tool yang dipakai model:

| Tool | Guna |
|---|---|
| `create_tool` | Menyusun tool baru → draft |
| `activate_tool` | Mengaktifkan draft (hanya setelah kamu setuju) |
| `list_my_tools` | Lihat tool aktif & draft |
| `remove_tool` | Hapus tool buatan sendiri |

## Gerbang keamanan

Kode buatan model **tidak langsung jalan**. Alurnya:

```
create_tool → DRAFT (nonaktif, di userPlugins/.drafts/)
            → kamu review kodenya + peringatan risiko
approve     → aktif (pindah ke userPlugins/, di-load)
```

- **Analisis risiko** menandai pola sensitif: menjalankan perintah
  sistem, akses berkas, jaringan, eval. Tidak memblokir — hanya
  memberi tahu supaya kamu tahu apa yang disetujui.
- **Plugin bawaan** tidak bisa ditimpa atau dihapus dari forge.
- Untuk otonomi penuh (langsung aktif tanpa persetujuan):
  `DAMAR_TOOL_AUTOAPPROVE=1` di `.env`. Default lebih aman.

## Manual (input / hapus sendiri)

Lewat API bidang kendali (dan Console):

| Method | Endpoint | Guna |
|---|---|---|
| GET | `/console/forge` | Daftar tool aktif + draft |
| GET | `/console/forge/:id` | Baca kode + manifest sebuah tool |
| POST | `/console/forge` | Buat/perbarui tool (`{id,name,tool:{name,parameters,code},activate}`) |
| POST | `/console/forge/:id/approve` | Setujui draft |
| POST | `/console/forge/:id/reject` | Tolak draft |
| DELETE | `/console/forge/:id` | Hapus tool |

## Bentuk tool

Tool tinggal di `userPlugins/<id>/` (terpisah dari kode inti,
gitignored). Isi `code` adalah badan fungsi `execute(context, args)`:

```js
// contoh code untuk tool 'slugify' dengan parameter { text }
const s = String(args.text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
return { slug: s };
```

Boleh memakai `require` Node bawaan dan `fetch`. Bisa diedit tangan
kapan saja lalu dimuat ulang.
