const { AITool } = require("../ai/tools");

const telemetry = require("./telemetryService");

/**
 * Tool media player — Aether bisa memutar musik & video langsung.
 *
 * Bukan hanya mencarikan link: benar-benar memutar di Console
 * lewat embedded player. Mendukung YouTube, Spotify, Vimeo, SoundCloud,
 * dan file lokal.
 *
 * Prinsip: hanya memutar konten yang sah dan legal.
 */

function playerTools() {

    return [

        new AITool({
            name: "play_youtube",
            description:
                "Putar video/musik dari YouTube langsung di Console. " +
                "Mencari video berdasarkan judul/artis, lalu memutarnya " +
                "di embedded player — bukan hanya membuka link. " +
                "Pakai saat pengguna minta 'putar lagu …', 'mainkan video …'.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Judul lagu/video yang dicari (mis. 'potong bebek angsa')." },
                    artist: { type: "string", description: "Artis/pencipta (opsional, untuk hasil lebih akurat)." }
                },
                required: ["query"]
            },
            execute: async ({ query, artist }) => {

                const q = artist ? `${query} ${artist}` : query;

                // Cari video lewat YouTube (tanpa API key — pakai scraping + oEmbed)
                const results = await searchYouTube(q);

                if (results.length === 0) {
                    return { ok: false, error: `Tidak menemukan video untuk "${q}".` };
                }

                const top = results[0];

                // UNDUH media sekali ke cache daemon (yt-dlp) lalu suruh
                // Console memutarnya dari daemon lokal. Memutar URL
                // googlevideo langsung dari <video> memicu "429 Too Many
                // Requests" (browser menembak banyak range) + macet;
                // menyajikan berkas lokal menghilangkan keduanya. Bila
                // unduhan gagal (yt-dlp tak ada dsb), mediaId null dan
                // Console jatuh ke embed seperti biasa.
                const { downloadMedia } = require("./streamResolver");
                const localPath = await downloadMedia(top.videoId);
                const mediaId = localPath ? `${top.videoId}.mp4` : null;

                telemetry.publish("aether:present", {
                    kind: "youtube",
                    videoId: top.videoId,
                    mediaId,
                    url: top.url,
                    title: top.title,
                    channel: top.channel,
                    thumbnail: top.thumbnail,
                    autoplay: true
                });

                return {
                    ok: true,
                    playing: top.title,
                    channel: top.channel,
                    url: top.url,
                    videoId: top.videoId,
                    via: mediaId ? "local-download" : "embed",
                    alternatives: results.slice(1, 4).map(r => ({ title: r.title, url: r.url }))
                };

            }
        }),

        new AITool({
            name: "play_media",
            description:
                "Putar media dari URL langsung (YouTube, Spotify, Vimeo, SoundCloud, dll) " +
                "di Console embedded player. Pakai bila sudah punya link pasti.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL media (YouTube/Spotify/Vimeo/SoundCloud/dll)." },
                    autoplay: { type: "boolean", description: "Putar otomatis (default true)." }
                },
                required: ["url"]
            },
            execute: async ({ url, autoplay = true }) => {

                const parsed = parseMediaUrl(String(url));

                if (!parsed) {
                    return { ok: false, error: "URL tidak dikenali. Didukung: YouTube, Spotify, Vimeo, SoundCloud." };
                }

                telemetry.publish("aether:present", {
                    kind: parsed.kind,
                    ...parsed,
                    autoplay
                });

                return { ok: true, playing: parsed.title ?? parsed.url, ...parsed };

            }
        }),

        new AITool({
            name: "stop_media",
            description:
                "Hentikan media yang sedang diputar di Console.",
            parameters: { type: "object", properties: {} },
            execute: async () => {

                telemetry.publish("aether:present", { kind: "stop" });

                return { ok: true, stopped: true };

            }
        }),

        new AITool({
            name: "search_music",
            description:
                "Cari lagu/musik di YouTube dan tampilkan daftar hasilnya. " +
                "Pakai saat pengguna tidak yakin judul pasti, atau ingin " +
                "memilih dari beberapa hasil. Tidak otomatis memutar.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Judul/artis yang dicari." },
                    limit: { type: "number", description: "Maksimum hasil (default 5)." }
                },
                required: ["query"]
            },
            execute: async ({ query, limit = 5 }) => {

                const results = await searchYouTube(query, limit);

                return {
                    ok: true,
                    query,
                    found: results.length,
                    results: results.map(r => ({
                        title: r.title,
                        channel: r.channel,
                        url: r.url,
                        videoId: r.videoId,
                        duration: r.duration
                    }))
                };

            }
        })

    ];

}

// ---- YouTube search (tanpa API key) -----------------------------------

/**
 * Cari video YouTube lewat scraping web langsung, API Piped, dan Invidious.
 */
async function searchYouTube(query, limit = 5) {

    // Method 1: HTML scraping langsung dari YouTube search (paling andal tanpa API key)
    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const res = await fetch(searchUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9"
            },
            signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
            const html = await res.text();
            const videoRegex = /"videoId":"([a-zA-Z0-9_-]{11})","thumbnail":{"thumbnails":\[{"url":"([^"]+)".*?"title":{"runs":\[{"text":"([^"]+)"}\],"accessibility":.*?"longBylineText":{"runs":\[{"text":"([^"]+)"/g;
            const matches = [];
            let match;
            while ((match = videoRegex.exec(html)) !== null && matches.length < limit) {
                matches.push({
                    videoId: match[1],
                    title: match[3],
                    channel: match[4],
                    url: `https://www.youtube.com/watch?v=${match[1]}`,
                    thumbnail: `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
                    duration: null
                });
            }
            if (matches.length > 0) return matches;
        }
    } catch { /* coba method berikutnya */ }

    // Method 2: iTunes / Apple Music oEmbed Fallback for Search
    try {
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=${limit}`;
        const res = await fetch(itunesUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                // Lakukan pencarian YouTube ulang berdasarkan nama lagu + artist yang akurat
                const topTrack = data.results[0];
                const refinedQuery = `${topTrack.trackName} ${topTrack.artistName}`;
                const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(refinedQuery)}`;
                const ytRes = await fetch(searchUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Accept-Language": "en-US,en;q=0.9"
                    },
                    signal: AbortSignal.timeout(5000)
                });
                if (ytRes.ok) {
                    const html = await ytRes.text();
                    const match = /"videoId":"([a-zA-Z0-9_-]{11})"/.exec(html);
                    if (match) {
                        return [{
                            videoId: match[1],
                            title: `${topTrack.trackName} - ${topTrack.artistName}`,
                            channel: topTrack.artistName,
                            url: `https://www.youtube.com/watch?v=${match[1]}`,
                            thumbnail: topTrack.artworkUrl100 || `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
                            duration: formatDuration(Math.floor(topTrack.trackTimeMillis / 1000))
                        }];
                    }
                }
            }
        }
    } catch { /* coba method berikutnya */ }

    // Method 3: Piped API
    const pipedInstances = [
        "https://pipedapi.kavin.rocks",
        "https://api.piped.privacydev.net",
        "https://piped-api.garudalinux.org"
    ];

    for (const base of pipedInstances) {
        try {
            const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) continue;
            const data = await res.json();
            const items = (data.items || []).slice(0, limit).map(v => ({
                videoId: v.url ? v.url.replace("/watch?v=", "") : v.id,
                title: v.title,
                channel: v.uploaderName,
                url: `https://www.youtube.com/watch?v=${v.url ? v.url.replace("/watch?v=", "") : v.id}`,
                thumbnail: v.thumbnail,
                duration: formatDuration(v.duration)
            }));
            if (items.length > 0) return items;
        } catch { /* lanjut */ }
    }

    // Method 4: Invidious
    const instances = [
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://iv.melmac.space",
        "https://invidious.f5.si"
    ];

    for (const base of instances) {
        try {
            const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`, {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(5000)
            });

            if (!res.ok) continue;

            const data = await res.json();

            const videos = (Array.isArray(data) ? data : [])
                .filter(v => v.type === "video" || v.videoId)
                .slice(0, limit)
                .map(v => ({
                    videoId: v.videoId,
                    title: v.title,
                    channel: v.author ?? v.channel,
                    url: `https://www.youtube.com/watch?v=${v.videoId}`,
                    thumbnail: v.videoThumbnails?.[0]?.url ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
                    duration: formatDuration(v.lengthSeconds)
                }));

            if (videos.length > 0) return videos;

        }
        catch { /* coba instance berikutnya */ }
    }

    return [];
}

/** Parse URL media menjadi embed info. */
function parseMediaUrl(url) {

    // Spotify (Track, Album, Playlist, Artist, Episode, Show)
    const spotifyMatch = url.match(/open\.spotify\.com\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
        const type = spotifyMatch[1];
        const id = spotifyMatch[2];
        return {
            kind: "spotify",
            type,
            spotifyId: id,
            url: `https://open.spotify.com/${type}/${id}`,
            embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
            title: `Spotify ${type.charAt(0).toUpperCase() + type.slice(1)}`,
            height: type === "track" ? 152 : 380
        };
    }

    // YouTube
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
        return {
            kind: "youtube",
            videoId: ytMatch[1],
            url: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
            embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1`,
            title: null
        };
    }

    // YouTube Music
    const ytmMatch = url.match(/music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (ytmMatch) {
        return {
            kind: "youtube",
            videoId: ytmMatch[1],
            url: `https://music.youtube.com/watch?v=${ytmMatch[1]}`,
            embedUrl: `https://www.youtube.com/embed/${ytmMatch[1]}?autoplay=1`,
            title: null
        };
    }

    // Vimeo
    const vimeoMatch = url.match(/vimeo\.com\/([0-9]+)/);
    if (vimeoMatch) {
        return {
            kind: "vimeo",
            vimeoId: vimeoMatch[1],
            url: `https://vimeo.com/${vimeoMatch[1]}`,
            embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}?autoplay=1`,
            title: null
        };
    }

    // SoundCloud
    if (url.includes("soundcloud.com/")) {
        return {
            kind: "soundcloud",
            url,
            embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true`,
            title: null
        };
    }

    return null;
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
}

// Ekspor NAMED, samakan dengan pemanggil (aiRuntimeService:
// `require("./playerTools").playerTools()`) dan saudaranya
// autonomyTools. Ekspor telanjang `module.exports = playerTools`
// membuat `.playerTools` undefined → `undefined()` melempar saat
// membangun engine, dan SATU error itu meruntuhkan seluruh tool
// registry (tools() jadi 0). Itulah sumber banyak task yang "gagal".
module.exports = { playerTools };
