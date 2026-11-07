const { AITool } = require("../ai/tools");

const telemetry = require("./telemetryService");

/**
 * Tool media player — Damar bisa memutar musik & video langsung.
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

                telemetry.publish("damar:present", {
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

                telemetry.publish("damar:present", {
                    kind: parsed.kind,
                    ...parsed,
                    autoplay
                });

                return { ok: true, playing: parsed.title ?? parsed.url, ...parsed };

            }
        }),

        new AITool({
            name: "play_spotify",
            description:
                "Putar lagu/musik dari Spotify langsung di Console lewat embedded player — " +
                "TANPA perlu membuka aplikasi Spotify. Mencari track/album/playlist " +
                "berdasarkan judul/artis lalu memutarnya di player Console. " +
                "Pakai saat pengguna minta 'putar di spotify', 'mainkan lagu … di spotify'.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Judul lagu/artis yang dicari (mis. 'bintang kecil')." },
                    type: { type: "string", enum: ["track", "album", "playlist"], description: "Jenis konten (default track)." },
                    artist: { type: "string", description: "Artis/pencipta (opsional, untuk hasil lebih akurat)." }
                },
                required: ["query"]
            },
            execute: async ({ query, type = "track", artist }) => {

                const q = artist ? `${query} ${artist}` : query;
                const results = await searchSpotify(q, String(type));

                if (results.length === 0) {
                    return { ok: false, error: `Tidak menemukan ${type} Spotify untuk "${q}". Coba play_youtube sebagai gantinya.` };
                }

                const top = results[0];

                telemetry.publish("damar:present", {
                    kind: "spotify",
                    type: top.type,
                    spotifyId: top.spotifyId,
                    url: top.url,
                    embedUrl: top.embedUrl,
                    title: top.title,
                    channel: top.artist,
                    thumbnail: top.thumbnail,
                    height: top.height,
                    autoplay: true
                });

                return {
                    ok: true,
                    playing: top.title,
                    artist: top.artist,
                    url: top.url,
                    spotifyId: top.spotifyId,
                    alternatives: results.slice(1, 4).map(r => ({ title: r.title, url: r.url }))
                };

            }
        }),

        new AITool({
            name: "stop_media",
            description:
                "Hentikan media yang sedang diputar di Console.",
            parameters: { type: "object", properties: {} },
            execute: async () => {

                telemetry.publish("damar:present", { kind: "stop" });

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

// ---- Spotify search (tanpa API key) ------------------------------------

const SPOTIFY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Bentuk hasil seragam untuk semua metode pencarian Spotify. */
function spotifyItem(type, id, { title = null, artist = null, thumbnail = null } = {}) {
    return {
        type,
        spotifyId: id,
        url: `https://open.spotify.com/${type}/${id}`,
        embedUrl: `https://open.spotify.com/embed/${type}/${id}?utm_source=damar`,
        title: title ?? `Spotify ${type}`,
        artist,
        thumbnail,
        height: type === "track" ? 152 : 380
    };
}

/** Pencarian via Web API resmi memakai Bearer token siap pakai. */
async function spotifyApiSearch(token, query, type, limit) {
    const apiRes = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) }
    );
    if (!apiRes.ok) return [];
    const data = await apiRes.json();
    const items = (data[`${type}s`]?.items ?? []).map(item => spotifyItem(type, item.id, {
        title: item.name,
        artist: item.artists?.map(a => a.name).join(", ") ?? null,
        thumbnail: item.album?.images?.[0]?.url
            ?? item.images?.[0]?.url
            ?? null
    }));
    return items;
}

/**
 * Cari konten Spotify. Urutan metode:
 *   1. Client Credentials resmi (SPOTIFY_CLIENT_ID/SECRET di .env) —
 *      paling andal; cukup untuk PENCARIAN, tanpa login pengguna.
 *   2. Token anonim web player — tanpa kredensial, kadang diblokir.
 *   3. Scraping halaman pencarian open.spotify.com — daya tahan
 *      terendah, hanya cadangan terakhir.
 */
async function searchSpotify(query, type = "track", limit = 5) {

    // Method 1: Client Credentials → Web API resmi Spotify.
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
        try {
            const cred = Buffer.from(
                `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
            ).toString("base64");
            const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
                method: "POST",
                headers: {
                    Authorization: `Basic ${cred}`,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: "grant_type=client_credentials",
                signal: AbortSignal.timeout(6000)
            });
            if (tokenRes.ok) {
                const { access_token } = await tokenRes.json();
                if (access_token) return await spotifyApiSearch(access_token, query, type, limit);
            }
        } catch { /* coba method berikutnya */ }
    }

    // Method 2: token anonim web player.
    try {
        const tokenRes = await fetch(
            "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
            { headers: { "User-Agent": SPOTIFY_UA, Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
        );
        if (tokenRes.ok) {
            const { accessToken } = await tokenRes.json();
            if (accessToken) return await spotifyApiSearch(accessToken, query, type, limit);
        }
    } catch { /* coba method berikutnya */ }

    // Method 3: scraping HTML halaman pencarian open.spotify.com —
    // kumpulkan ID unik dari URI yang tersemat di SSR payload.
    try {
        const searchUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
        const res = await fetch(searchUrl, {
            headers: { "User-Agent": SPOTIFY_UA, "Accept-Language": "en-US,en;q=0.9" },
            signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
            const html = await res.text();
            const ids = [];
            const idRegex = new RegExp(`spotify:(?:${type}):([0-9A-Za-z]{22})`, "g");
            let match;
            while ((match = idRegex.exec(html)) !== null) {
                if (!ids.includes(match[1])) ids.push(match[1]);
                if (ids.length >= limit) break;
            }

            // Fallback pattern: URL bentuk /track/ID di dalam JSON embed
            if (ids.length === 0) {
                const urlRegex = new RegExp(`open\\.spotify\\.com/(?:embed/)?${type}/([0-9A-Za-z]{22})`, "g");
                while ((match = urlRegex.exec(html)) !== null) {
                    if (!ids.includes(match[1])) ids.push(match[1]);
                    if (ids.length >= limit) break;
                }
            }

            if (ids.length > 0) {
                // oEmbed publik: judul + thumbnail per item, tanpa auth.
                const items = await Promise.all(ids.map(async id => {
                    try {
                        const oeRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`, {
                            headers: { "User-Agent": SPOTIFY_UA },
                            signal: AbortSignal.timeout(5000)
                        });
                        if (oeRes.ok) {
                            const oe = await oeRes.json();
                            return spotifyItem(type, id, { title: oe.title, thumbnail: oe.thumbnail_url });
                        }
                    } catch { /* pakai judul generik */ }
                    return spotifyItem(type, id);
                }));
                return items;
            }
        }
    } catch { /* beri tahu pemanggil kosong */ }

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
