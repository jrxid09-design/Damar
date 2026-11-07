// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class GoogleMapsTool {

    constructor() {
        this.name = "googleMaps";
        this.description = "Layanan integrasi Google Maps untuk pencarian lokasi (searchPlace), rute perjalanan (getDirections), dan pembuatan URL gambar peta statis (showMap).";
        this.parameters = {
                "action": {
                        "type": "string",
                        "description": "Aksi yang ingin dijalankan: 'searchPlace', 'getDirections', atau 'showMap'",
                        "required": true
                },
                "query": {
                        "type": "string",
                        "description": "Kata kunci/lokasi pencarian (untuk action 'searchPlace')",
                        "required": false
                },
                "origin": {
                        "type": "string",
                        "description": "Titik keberangkatan/asal (untuk action 'getDirections')",
                        "required": false
                },
                "destination": {
                        "type": "string",
                        "description": "Titik tujuan/destinasi (untuk action 'getDirections' dan 'showMap')",
                        "required": false
                },
                "mode": {
                        "type": "string",
                        "description": "Moda transportasi: driving, walking, bicycling, transit (default: driving)",
                        "required": false
                },
                "zoom": {
                        "type": "number",
                        "description": "Tingkat zoom peta statis (1-20, default: 13)",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.MAPS_API_KEY || args.apiKey;
        const action = args.action;

        if (!action) {
          return { ok: false, error: "Parameter 'action' wajib diisi (searchPlace | getDirections | showMap)." };
        }

        if (action === 'showMap') {
          const center = encodeURIComponent(args.destination || args.query || 'Jakarta');
          const zoom = args.zoom || 13;
          const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${center}&zoom=${zoom}&size=600x400&maptype=roadmap${apiKey ? `&key=${apiKey}` : ''}`;
          return {
            ok: true,
            action: 'showMap',
            url: staticMapUrl,
            note: apiKey ? "URL Static Map Google Maps siap ditampilkan." : "Peringatan: API Key belum dikonfigurasi."
          };
        }

        if (!apiKey) {
          return { 
            ok: false, 
            error: "API Key Google Maps tidak ditemukan. Pastikan GOOGLE_MAPS_API_KEY telah diset di environment." 
          };
        }

        try {
          if (action === 'searchPlace') {
            if (!args.query) return { ok: false, error: "Parameter 'query' dibutuhkan untuk searchPlace." };
            const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(args.query)}&key=${apiKey}`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.status !== 'OK') {
              return { ok: false, error: `Google API Error: ${data.status}`, detail: data.error_message };
            }
            
            const results = data.results.map(item => ({
              formatted_address: item.formatted_address,
              location: item.geometry.location,
              place_id: item.place_id
            }));
            
            return { ok: true, action: 'searchPlace', count: results.length, results };
          }

          if (action === 'getDirections') {
            if (!args.origin || !args.destination) {
              return { ok: false, error: "Parameter 'origin' dan 'destination' dibutuhkan untuk getDirections." };
            }
            const mode = args.mode || 'driving';
            const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(args.origin)}&destination=${encodeURIComponent(args.destination)}&mode=${mode}&key=${apiKey}`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.status !== 'OK') {
              return { ok: false, error: `Google Directions API Error: ${data.status}`, detail: data.error_message };
            }
            
            const route = data.routes[0];
            const leg = route.legs[0];
            
            return {
              ok: true,
              action: 'getDirections',
              origin: leg.start_address,
              destination: leg.end_address,
              distance: leg.distance.text,
              duration: leg.duration.text,
              steps: leg.steps.map(s => ({
                instruction: s.html_instructions.replace(/<[^>]*>?/gm, ''),
                distance: s.distance.text,
                duration: s.duration.text
              }))
            };
          }

          return { ok: false, error: `Aksi '${action}' tidak dikenal.` };
        } catch (err) {
          return { ok: false, error: err.message };
        }
    }

}

module.exports = [ new GoogleMapsTool() ];
