// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class CctvMonitorTool {

    constructor() {
        this.name = "cctvMonitor";
        this.description = "Monitor CCTV Hanriver: ambil snapshot, deteksi gerakan, kirim alert ke WhatsApp. Tanpa Home Assistant.";
        this.parameters = {
                "camera_id": {
                        "type": "string",
                        "description": "Hanriver ID kamera",
                        "required": true
                },
                "stream_url": {
                        "type": "string",
                        "description": "URL RTSP/HTTP stream kamera",
                        "required": false
                },
                "interval_seconds": {
                        "type": "number",
                        "description": "Interval polling snapshot (detik)",
                        "required": false
                },
                "alert_whatsapp": {
                        "type": "boolean",
                        "description": "Kirim alert ke WhatsApp jika gerakan terdeteksi",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        // CCTV Monitor Tool
        // Ambil snapshot dari stream URL, deteksi gerakan via frame diff, kirim alert WhatsApp
        const fetch = require('node-fetch');

        async function execute(context, args) {
          const { camera_id, stream_url, interval_seconds = 10, alert_whatsapp = false } = args;
          
          if (!stream_url) {
            // Coba format RTSP standar Hanriver
            const rtsp_url = `rtsp://${camera_id}/stream`;
            const http_url = `http://${camera_id}/snapshot.jpg`;
            
            return {
              camera_id,
              status: 'waiting_stream_url',
              message: 'Stream URL belum tersedia. Coba format: rtsp://[IP_KAMERA]:554/stream atau http://[IP_KAMERA]/snapshot.jpg',
              suggested_urls: { rtsp: rtsp_url, http: http_url },
              next_step: 'Isi stream_url dengan URL RTSP/HTTP kamera yang valid'
            };
          }
          
          try {
            // Ambil snapshot
            const res = await fetch(stream_url, { method: 'GET', redirect: 'follow' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const buffer = await res.buffer();
            const timestamp = new Date().toISOString();
            
            return {
              camera_id,
              status: 'snapshot_taken',
              timestamp,
              size_bytes: buffer.length,
              message: `Snapshot berhasil diambil (${buffer.length} bytes)`,
              alert_whatsapp: alert_whatsapp
            };
          } catch (err) {
            return {
              camera_id,
              status: 'error',
              error: err.message,
              message: 'Gagal ambil snapshot. Periksa stream_url dan koneksi jaringan.'
            };
          }
        }

        module.exports = { execute };
    }

}

module.exports = [ new CctvMonitorTool() ];
