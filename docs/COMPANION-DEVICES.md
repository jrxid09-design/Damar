# Companion Devices — Device Tertaut

Aether bisa dikendalikan dari **device lain di jaringan yang sama** (HP,
laptop, tablet) — atau Bluetooth PAN — sehingga device itu bisa memakai
**tools & skill yang sama dengan PC ini**.

> Prinsip inti: device adalah **client tipis**. Tidak ada otak AI kedua,
> tidak ada tool system duplikat. Device memakai jalur Aether Core yang
> SUDAH ada: REST + MCP + chat (`aiRuntime.chat({ channel: "device" })`),
> sehingga ToolSelector, memory, consciousness, MCP tools, dan audit trail
> semuanya otomatis berlaku.

---

## Arsitektur

```
                    AETHER CORE (daemon :3000)
                         │  tools/skill/chat via REST + MCP + chat
        ┌────────────────┼────────────────┬────────────────┐
    Telegram       WhatsApp        Voice        DEVICE TERTAUT
                                                 │ (HP/laptop/tablet)
                                 HTTP + token device (pairing)
```

Komponen (`src/companion/`):

| File | Peran |
|---|---|
| `deviceRegistry.js` | Daftar device + kredensial per device (JsonStore) |
| `pairing.js` | Kode pairing 6 digit + TTL (dibuat oleh pemilik) |
| `companionGateway.js` | Jembatan chat → `aiRuntime` (channel `device`) |
| `deviceController.js` | REST endpoints |
| `deviceWeb.js` | Halaman web hologram JARVIS untuk device |
| `index.js` | Entry + `deviceAuth` middleware (token per device) |

## Alur pairing (kode dimulai dari OWNER)

```
1. Pemilik buat kode     → Console → Devices → "Mulai pairing"
                          → POST /api/v1/console/companion/pair → kode 6 digit
2. Device join           → buka http://<ip-pc>:3000/companion di browser device
                          → masukkan kode + nama → POST /api/v1/companion/join
                          → token dikembalikan LANGSUNG ke device
3. Device memakai token  → chat / tools via /api/v1/companion/*
4. Pemilik mencabut      → Console → Devices → "Cabut"
```

- Kode berlaku 10 menit (TTL), maks 5 permintaan menggantung.
- Token per device (acak), bisa dicabut tanpa mengganggu device lain.
- Device TIDAK butuh token owner untuk join — cukup kode dari pemilik.
- Token tersimpan di localStorage device; hapus data situs = keluar.

## Akses dari luar jaringan (Tailscale)

Device tidak harus satu WiFi dengan PC — cukup **Tailscale** di kedua
perangkat (akun sama), lalu HP memakai internet seluler biasa:

1. Install Tailscale di PC & HP, login akun yang sama.
2. PC mendapat IP virtual stabil `100.x.y.z` (+ nama MagicDNS).
3. Console → Devices → panel "Device Tertaut" menampilkan **alamat akses**
   otomatis terdeteksi: Tailscale didahulukan, lalu LAN.
4. Tekan **QR** pada alamat pilihan → scan dari HP → halaman companion terbuka.

Koneksi terenkripsi WireGuard; hanya perangkat di tailnet Anda yang bisa
menjangkau daemon. Tanpa buka port router, tanpa ekspos publik.

## Halaman web device v3 (orb-only, hologram Siri/LiveKit)

Halaman `/companion` (`deviceWeb.js`, vanilla JS). **Desain final: hanya ORB**
di panggung — semua lainnya opsional:

- **Orb WebGL shader** — fragment shader *fbm + domain-warping 2-tahap*
  (teknik yang sama dengan orb LiveKit Agents): blob "cair" organik yang
  tidak pernah berulang, tepi bergelombang noise, cincin detail rasa
  ekualiser (dikuasai treble), rim fresnel, denyut inti. **Reaktif suara
  nyata**: pita bass/mid/treble dari FFT mic (listening) atau audio TTS
  server (speaking) dimasukkan sebagai uniform; thinking = putaran cepat.
  Fallback CSS bila WebGL tak tersedia.
- **Tahan orb = push-to-talk** — tekan-tahan untuk bicara, **lepas = kirim**.
  Tahan saat Aether bicara = barge-in (TTS dipotong).
- **Kotak ketik menempel di panel chat** — panel chat opsional (☰); tidak ada
  lagi tombol mic terpisah dan quick chips (dihapus).
- **STT live** — Web Speech API bila ada; fallback MediaRecorder →
  `/companion/transcribe` (faster-whisper).
- **TTS dua mode** (⚙): Browser (kalimat-per-kalimat selama streaming) atau
  Server Ardi via `/companion/tts`; orb menari mengikuti audio aslinya.
- **Setelan ⚙ kini bisa ganti OTAK AI** — pilih **provider** & **model** sama
  seperti Console (`/ai/providers`, `/ai/models`, `/ai/select`). Berguna saat
  kuota 429: pindah otak langsung dari HP.
- Media dirender; lampiran 📎 diunggah & diberitahukan ke Aether.

## ⚠️ Mic butuh HTTPS (secure context)

Browser memblokir mikrofon di `http://<ip>` non-lokal — termasuk
`http://100.x…` (Tailscale IP). Gejala: status "MIC DITOLAK"/"MIC BUTUH HTTPS".

**Solusi resmi Tailscale (sekali jalan, di PC):**

```
tailscale serve 3000
```

Perangkat lalu membuka **`https://<nama-pc>.<tailnet>.ts.net/companion`** —
TLS valid otomatis → mic hidup. Alamat HTTPS ini pun muncul normal di
Console (masuk lewat nama ts.net).

Chat teks via ☰ tetap berfungsi tanpa HTTPS.

## Endpoint lengkap

| Method | Path | Auth | Guna |
|---|---|---|---|
| GET | `/companion` | publik | Halaman web device (pairing + chat) |
| POST | `/api/v1/console/companion/pair` | owner | Buat kode pairing |
| GET | `/api/v1/console/companion/list` | owner | Device + pending + alamat akses |
| GET | `/api/v1/console/companion/qr?url=` | owner | QR code URL companion |
| POST | `/api/v1/console/companion/:id/revoke` | owner | Cabut device |
| POST | `/api/v1/companion/join` | kode pairing | Join → dapat token device |
| POST | `/api/v1/companion/chat` | device | Chat non-stream |
| POST | `/api/v1/companion/chat/stream` | device | Chat SSE streaming |
| POST | `/api/v1/companion/transcribe` | device | STT (audio base64) |
| POST | `/api/v1/companion/tts` | device | TTS (suara Aether) |
| POST | `/api/v1/companion/upload` | device | Unggah lampiran |
| GET | `/api/v1/companion/media/:file` | device (`?token=`) | Sajikan lampiran |
| GET | `/api/v1/companion/tools` | device | Daftar tools/skill |
| GET | `/api/v1/companion/ai/providers` | device | Daftar provider AI |
| GET | `/api/v1/companion/ai/models` | device | Daftar model per provider |
| POST | `/api/v1/companion/ai/select` | device | Ganti otak AI aktif |
| GET | `/api/v1/companion/ai/config` | device | Baca config penuh (key dimasking) |
| POST | `/api/v1/companion/ai/config` | device | Simpan provider+**API key**+URL+model |

## Pairing dari Console

Console → **Devices** (panel "Device Tertaut"):

1. Tekan **"Mulai pairing"** → muncul **kode 6 digit** (berlaku ~10 menit).
2. Di device, buka salah satu **alamat akses** (atau scan **QR**).
3. Masukkan kode + nama device → **Hubungkan**.
4. Device otomatis tertaut dan masuk layar orb.
5. Untuk mencabut: Console → Devices → **"Cabut"**.

## Keamanan

- **Dua lapis auth**: endpoint manajemen (pair/approve/list/revoke) butuh
  token owner; endpoint chat/tools butuh token device.
- Perintah device tetap lewat `ToolRegistry` → toolGuard/riskPolicy/audit
  yang sama. Device BUKAN "trusted channel" yang bebas.
- `allowedTools` (per device) bisa membatasi tool bila diperlukan.

## Kalau semua URL tak merespon

Itu tanda **daemon mati**, bukan masalah jaringan (`tailscale serve` hanya
proxy ke `localhost:3000`). Di PC: jalankan `npm run aether`, pastikan
`http://localhost:3000/health` membalas JSON, maka kedua URL (LAN & ts.net)
otomatis hidup. Cek `tailscale serve status`; bila kosong:
`tailscale serve --bg 3000`.

## Bluetooth

Saat ini koneksi lewat **jaringan (LAN / Bluetooth PAN)** via HTTP — jalan
penuh di semua OS tanpa dependency native. Bluetooth klasik/BLE (RFCOMM,
GATT) butuh stack OS + dependency native yang rawan (terutama WSL2/Linux),
jadi ditandai sebagai **peta lanjutan**.

## Test

`tests/companion/` — 20 test:
- `companion.test.js` (12): registry, pairing request→join, gateway chat/auth.
- `addresses.test.js` (5): klasifikasi Tailscale/LAN, prioritas URL.
- `deviceV2.test.js` (3): chatStream delta+persist, upload anti-traversal,
  content-type.

## Peta lanjutan

1. **Bluetooth BLE/classic** — streaming perintah lewat RFCOMM/GATT (butuh
   dependency native + uji di hardware nyata).
2. **Discovery mDNS** — alternatif selain Tailscale (`_aether._tcp`).
3. **Per-device permission UI** — `allowedTools` dikelola dari Console.
4. **STT server streaming penuh** — chunked ke faster-whisper.
5. **Orb WebGL/shader** — kualitas LiveKit penuh bila mau naik kelas
   (saat ini canvas 2D sudah ekualiser 3-band).
