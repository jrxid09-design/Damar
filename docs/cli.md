# Aether CLI

Antarmuka terminal untuk Aether. Perannya sama seperti Console
desktop — klien tipis ke daemon — tapi hidup di terminal: ngobrol
dengan jawaban streaming, cek status, kelola model, telusuri
memori, dan jalankan tool.

## Menjalankan

Pastikan daemon hidup dulu:

```bash
npm start
```

Lalu, di terminal lain:

```bash
npm run cli
```

Atau setelah `npm link` / instalasi global, langsung:

```bash
aether
```

### Sekali jalan & pipa

Tanya satu hal lalu keluar (cocok untuk skrip):

```bash
aether "ringkas status server hari ini"
```

Baca dari pipa:

```bash
echo "jam berapa sekarang?" | aether
```

### Menyambung ke daemon lain

Saat daemon berjalan di PC rumah, arahkan CLI dari laptop:

```bash
aether --url http://192.168.1.20:3000 --token TOKEN_KAMU
```

Atau lewat environment: `AETHER_URL`, `AETHER_TOKEN`.

## Perintah

Ketik apa saja untuk ngobrol. Baris berawalan `/` adalah perintah:

| Perintah | Guna |
|---|---|
| `/help` | Daftar perintah |
| `/status` | Ringkasan kesiapan (CPU/RAM, provider, integrasi, memori) |
| `/models` | Daftar model provider aktif |
| `/model <id>` | Set model default |
| `/provider <id>` | Ganti provider (llamacpp / openrouter / groq / dst) |
| `/recall <kata>` | Cari memori jangka panjang |
| `/remember <teks>` | Simpan memori baru |
| `/forget <id>` | Hapus satu memori (lihat id dari `/recall`) |
| `/tools` | Daftar tool terdaftar |
| `/run <id> <json>` | Jalankan tool manual, mis. `/run calculator.calculator {"operation":"add","a":2,"b":3}` |
| `/reset` | Kosongkan konteks percakapan |
| `/clear` | Bersihkan layar |
| `/exit` | Keluar |

**Ctrl-C** saat Aether menjawab akan membatalkan jawaban itu, bukan
menutup CLI. Tekan lagi saat menganggur untuk keluar.

## Catatan

- CLI dan Console memakai bidang kendali (`/api/v1/console`) yang
  sama, jadi keduanya selalu sinkron saat API berubah.
- Konteks percakapan disimpan selama sesi berjalan supaya Aether
  nyambung antar pertanyaan; `/reset` mengosongkannya.
- Injeksi memori otomatis tetap berlaku — jawaban pertama pun sudah
  mempertimbangkan apa yang Aether ingat tentang kamu.
