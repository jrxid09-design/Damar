# Damar Console

Aplikasi desktop (Electron) untuk memantau dan mengendalikan daemon Damar:
kesiapan sistem, chat langsung dengan AI, manajemen model, plugin & tool,
integrasi eksternal, serta konfigurasi mikrofon/kamera/sensor.

Console tidak menyimpan state sendiri — semuanya dibaca dari daemon lewat
HTTP, sehingga aplikasi yang sama bisa menunjuk ke laptop (development)
maupun PC rumah (produksi) hanya dengan mengganti alamat.

---

## Menjalankan

```bash
npm install
```

```bash
npm run console:install
```

Jalankan daemon lebih dulu:

```bash
npm start
```

Lalu Console di terminal terpisah:

```bash
npm run console
```

Console juga bisa menjalankan daemon sendiri sebagai proses anak — buka
tab **Settings → Daemon lokal → Jalankan**. Berguna saat mengembangkan di
laptop; di PC rumah sebaiknya daemon dijalankan sebagai service terpisah
agar tetap hidup saat Console ditutup.

---

## Halaman

| Halaman | Isi |
|---|---|
| **Dashboard** | Kartu kesiapan (daemon, mic, kamera, sensor, tool), gauge CPU/RAM dengan sparkline, metrik AI, aktivitas terakhir. |
| **Logs** | Aliran log realtime dari daemon lewat SSE, dengan filter level dan teks. |
| **Chat** | Percakapan streaming token-per-token. Provider dan model bisa diganti dari sini. Model boleh memanggil tool plugin. |
| **Models** | Daftar model tiap provider; untuk model lokal tampil ukuran, jumlah parameter, dan kuantisasi. Bisa menetapkan model default. |
| **Plugins & Tools** | Plugin yang ter-load dan seluruh tool terdaftar. Tool bisa dijalankan manual dengan argumen JSON. |
| **Integrations** | Manajer MCP & otak eksternal. Base URL bisa diubah sementara untuk uji coba. |
| **Devices** | Pilih mikrofon dan kamera (dengan level meter dan pratinjau langsung), atur sample rate, VAD, wake word, resolusi, dan interval tangkap. Kelola sensor berbasis endpoint HTTP. |
| **Settings** | Alamat daemon, token, interval polling, kendali daemon lokal. |

Pintasan: `Ctrl+1` … `Ctrl+8` untuk berpindah halaman.

---

## Menghubungkan ke PC rumah

Di **PC rumah**, isi `.env`:

```
HOST=0.0.0.0
PORT=3000
DAMAR_TOKEN=<token-acak-panjang>
```

Di **laptop**, buka Console → **Settings**:

- Alamat daemon: `http://<ip-lan-pc>:3000`
- Token akses: token yang sama dengan `DAMAR_TOKEN`

> Daemon mendengarkan di `0.0.0.0`, jadi begitu berjalan di PC rumah ia
> terjangkau semua perangkat pada LAN yang sama. Tanpa `DAMAR_TOKEN`,
> endpoint chat, eksekusi tool, dan filesystem terbuka tanpa autentikasi.
> Set token sebelum daemon dipakai di jaringan bersama.

---

## Arsitektur singkat

```
apps/console/
  main.js              proses utama Electron; jendela, IPC, daemon lokal
  preload.js           contextBridge — satu-satunya jembatan ke Node
  renderer/
    app.js             router, koneksi, polling, aliran SSE
    lib/api.js         klien REST + parser SSE untuk chat streaming
    lib/store.js       state global + riwayat metrik
    lib/ui.js          pemformatan, gauge, sparkline, toast
    lib/icons.js       ikon SVG inline (tanpa CDN, jalan offline)
    views/*.js         satu modul per halaman
    styles/*.css       token desain, tata letak, komponen
```

Renderer berjalan tanpa akses Node (`contextIsolation: true`,
`nodeIntegration: false`) dan dibatasi CSP; semua yang menyentuh sistem
lewat `preload.js`.

---

## Bidang kendali (Console API)

Semua di bawah `/api/v1/console`. Bila `DAMAR_TOKEN` diset, sertakan
header `Authorization: Bearer <token>`.

| Method | Endpoint | Guna |
|---|---|---|
| GET | `/overview` | Satu panggilan yang mengisi seluruh dashboard |
| GET | `/stats` | Metrik host & proses |
| GET | `/logs?limit=&level=` | Log terakhir |
| GET | `/events` | SSE: log + event realtime |
| GET | `/ai/providers` | Provider terdaftar + status |
| POST | `/ai/provider` | Ganti provider aktif |
| GET | `/ai/models?provider=` | Daftar model |
| POST | `/ai/model` | Set model default |
| GET | `/ai/metrics` | Statistik request AI |
| POST | `/ai/chat` | Chat non-streaming |
| POST | `/ai/stream` | Chat streaming (SSE) |
| GET | `/plugins` | Plugin ter-load |
| GET | `/tools` | Tool terdaftar |
| POST | `/tools/:id/execute` | Jalankan tool manual |
| GET | `/integrations` | Status semua integrasi |
| POST | `/integrations/check` | Probe ulang semuanya |
| POST | `/integrations/:id/check` | Probe satu integrasi |
| PATCH | `/integrations/:id` | Ubah baseUrl/enabled (sementara) |
| GET | `/devices` | Konfigurasi perangkat |
| PUT | `/devices` | Simpan konfigurasi perangkat |
| POST | `/devices/sensors` | Tambah sensor |
| DELETE | `/devices/sensors/:id` | Hapus sensor |
| GET | `/devices/sensors/readings` | Baca semua sensor |

---

## Sensor

Damar tidak membaca hardware secara langsung. Setiap sensor didefinisikan
sebagai endpoint HTTP yang mengembalikan JSON:

```json
{
  "id": "suhu-ruang",
  "label": "Suhu Ruang",
  "type": "temperature",
  "unit": "°C",
  "url": "http://192.168.1.50/api/sensor",
  "valuePath": "data.temperature"
}
```

`valuePath` adalah jalur bertitik ke nilai di dalam response. Pendekatan ini
membuat ESP32, Home Assistant, maupun skrip Python di PC rumah diperlakukan
sama tanpa perubahan kode.
