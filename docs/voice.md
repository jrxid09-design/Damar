# Damar Hidup — Avatar & Suara

Layar **Damar** di Console adalah wajah entitasnya: minibot yang
bereaksi terhadap percakapan, ngobrol dengan suara masuk & keluar.

## Avatar minibot

Karakter SVG dengan mesin-status yang berganti ekspresi:

| State | Tampilan |
|---|---|
| `idle` | Mengambang pelan, berkedip berkala |
| `listening` | Aura menyala, mata membesar, antena berdenyut |
| `thinking` | Mata melirik ke atas, titik-titik berkedip |
| `speaking` | Mulut bergerak mengikuti ucapan |
| `happy` | Mata `^^`, senyum |
| `error` | Mata `><` |
| `offline` | Redup keabu-abuan |

Alur otomatis mengikuti percakapan:
`menyimak → berpikir → berbicara → siap`.

Ini murni antarmuka — keputusan tetap dari sistem AI di belakangnya —
tapi kehadirannya membuat Damar terasa hadir, bukan sekadar kotak teks.

## Suara keluar (TTS)

Damar berbicara memakai suara OS lewat `speechSynthesis`:
**offline, tanpa server**. Pilih suara di pojok kanan atas layar
Damar; kalau ada suara berbahasa Indonesia terpasang di Windows, itu
dipakai sebagai default.

Menambah suara Indonesia di Windows: *Settings → Time & Language →
Speech → Manage voices → Add* (mis. "Microsoft Andika").

Toggle **Suara** mengaktif/menonaktifkan output. Saat aktif, mulut
avatar bergerak mengikuti kata.

## Suara masuk (STT)

Tekan mikrofon untuk bicara. Renderer merekam audio, mengirimnya ke
daemon, lalu daemon meneruskan ke backend transcribe.

STT **konfigurabel & opsional**. Tanpa `DAMAR_STT_URL`, tombol mic
dinonaktifkan dengan penjelasan — mengetik tetap bisa dan Damar tetap
menjawab dengan suara.

### Menyiapkan STT lokal

Jalankan backend transcribe kompatibel-OpenAI, contoh
[faster-whisper-server](https://github.com/fedirz/faster-whisper-server):

```bash
docker run -p 8000:8000 fedirz/faster-whisper-server:latest-cpu
```

Lalu di `.env` daemon:

```
DAMAR_STT_URL=http://localhost:8000/v1/audio/transcriptions
DAMAR_STT_MODEL=Systran/faster-whisper-base
```

Untuk hasil lebih cepat/akurat di PC rumah ber-GPU, pakai image GPU
dan model yang lebih besar (`faster-whisper-medium`).

## Catatan

- Percakapan di layar Damar berbagi runtime yang sama dengan Chat/CLI,
  termasuk injeksi memori otomatis — jawaban suaranya pun sudah
  mempertimbangkan apa yang Damar ingat.
- TTS diverifikasi memuat suara OS; **keluaran audio sesungguhnya
  dikonfirmasi dari perangkatmu** (headless test tidak berbunyi).
- STT diverifikasi sampai lapisan endpoint + fallback; transkripsi
  nyata perlu `DAMAR_STT_URL` aktif dan mic asli.
