# Damar di Telegram

Remote control Damar dari mana saja lewat Telegram. Memakai
long-polling — **tidak perlu port publik, domain, atau webhook**, jadi
jalan mulus dari balik NAT rumah.

## Menyiapkan

1. Buat bot lewat [@BotFather](https://t.me/BotFather), salin token-nya.
2. Di `.env` daemon:

   ```
   DAMAR_TELEGRAM_TOKEN=123456:ABC-DEF...
   ```

3. Jalankan daemon, lalu kirim `/id` ke bot-mu. Ia membalas chat id-mu.
4. Tambahkan chat id itu ke `.env` dan jalankan ulang:

   ```
   DAMAR_TELEGRAM_ALLOWED=123456789
   ```

Beberapa id dipisah koma untuk mengizinkan anggota keluarga.

## Keamanan

Bot **hanya membalas chat id yang terdaftar** di
`DAMAR_TELEGRAM_ALLOWED`. Tanpa allowlist, bot hanya mau menjawab
`/id` dan menolak yang lain — supaya rumahmu tidak bisa dikendalikan
orang asing yang kebetulan menemukan bot. Daftarkan id-mu dulu sebelum
bot benar-benar berguna.

## Pemakaian

Ketik apa saja untuk ngobrol — jawaban datang dari otak Damar yang
sama (lengkap dengan memori jangka panjang dan tool). Perintah:

| Perintah | Guna |
|---|---|
| `/status` | Kesiapan sistem (CPU/RAM, provider, uptime) |
| `/recall <kata>` | Cari memori jangka panjang |
| `/reset` | Kosongkan konteks percakapan |
| `/id` | Tampilkan chat id (selalu boleh) |
| `/help` | Daftar perintah |

## Notifikasi proaktif

`telegramService.broadcast(text)` mengirim pesan ke semua chat yang
diizinkan. Ini fondasi untuk pemberitahuan otomatis nanti — mis. CCTV
mendeteksi seseorang, backup NAS selesai, atau container mati.

## Catatan

- Konteks percakapan disimpan per-chat selama daemon berjalan;
  `/reset` mengosongkannya.
- Status bisa dicek di `GET /api/v1/console/telegram/status`.
- Bila `DAMAR_TELEGRAM_TOKEN` belum diset, bot nonaktif diam-diam —
  daemon tetap jalan normal.
