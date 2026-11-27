"use strict";
// registry schema tag: 43598735b86a6674

/**
 * registry — SATU sumber kebenaran suite MCP Produktivitas Damar.
 *
 * Setiap server produktivitas dideklarasikan di sini sebagai data murni:
 * id, nama tampilan, jenis autentikasi, aksi connect, pemeriksaan
 * kesehatan, dan daftar tool beserta tingkat risikonya. Registry ini
 * dikonsumsi oleh:
 *   - connectService (alur connect/login di Control Dashboard),
 *   - server stdio suite (tools/list diturunkan dari sini),
 *   - riskCatalog (tool tier "write" WAJIB terklasifikasi destruktif),
 *   - dokumentasi (docs/mcp-productivity.md ditulis dari data ini).
 *
 * Tingkat tool:
 *   - "read"  : hanya membaca; berjalan langsung (tetap teraudit).
 *   - "write" : mengubah dunia luar (kirim/unggah/hapus/putar/buat).
 *               Terpetakan ke gerbang persetujuan pemilik lewat
 *               riskCatalog (entri DESTRUCTIVE eksplisit per tool) —
 *               persis kebijakan tool destruktif Damar yang sudah ada.
 *
 * Registry ini DATA, bukan otoritas: memiliki token tidak pernah
 * memberi izin; setiap pemanggilan tool tetap melewati canonical
 * action path + toolGuard Damar (lihat mcpClient.bridge()).
 */

const S = (properties, required = []) => ({
    type: "object",
    properties,
    ...(required.length ? { required } : {})
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const tool = (name, tier, description, inputSchema, extra = {}) =>
    Object.freeze({ name, tier, description, inputSchema, ...extra });

/**
 * Konfigurasi OAuth per PROVIDER (bukan per server: satu consent
 * Google melayani Gmail+Drive+Calendar; satu consent Microsoft
 * melayani Outlook+OneDrive+Calendar).
 *
 * Damar lokal-first tanpa backend cloud: client OAuth adalah milik
 * pengguna akhir (dibuat sekali di konsol provider, ditempel ke
 * Dashboard, disimpan HANYA di Secret Vault). Setelah itu connect
 * cukup satu klik. Lihat docs/mcp-productivity.md.
 */
const OAUTH_PROVIDERS = Object.freeze({

    google: Object.freeze({
        id: "google",
        displayName: "Google",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        revokeUrl: "https://oauth2.googleapis.com/revoke",
        scopeSeparator: " ",
        tokenAuth: "body",
        extraAuthorizeParams: Object.freeze({
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true"
        }),
        baseScopes: Object.freeze(["https://www.googleapis.com/auth/userinfo.email"]),
        services: Object.freeze({
            gmail: Object.freeze({
                label: "Gmail",
                scopes: Object.freeze([
                    "https://www.googleapis.com/auth/gmail.modify",
                    "https://www.googleapis.com/auth/gmail.send"
                ])
            }),
            drive: Object.freeze({
                label: "Google Drive",
                scopes: Object.freeze(["https://www.googleapis.com/auth/drive"])
            }),
            calendar: Object.freeze({
                label: "Google Calendar",
                scopes: Object.freeze([
                    "https://www.googleapis.com/auth/calendar.events",
                    "https://www.googleapis.com/auth/calendar.readonly"
                ])
            })
        })
    }),

    microsoft: Object.freeze({
        id: "microsoft",
        displayName: "Microsoft",
        authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        revokeUrl: null, // Microsoft tidak punya endpoint revoke publik; disconnect = hapus token lokal.
        scopeSeparator: " ",
        tokenAuth: "body",
        extraAuthorizeParams: Object.freeze({ prompt: "select_account" }),
        baseScopes: Object.freeze(["offline_access", "User.Read"]),
        services: Object.freeze({
            mail: Object.freeze({
                label: "Outlook Mail",
                scopes: Object.freeze(["Mail.Read", "Mail.Send"])
            }),
            drive: Object.freeze({
                label: "OneDrive",
                scopes: Object.freeze(["Files.ReadWrite"])
            }),
            calendar: Object.freeze({
                label: "Outlook Calendar",
                scopes: Object.freeze(["Calendars.ReadWrite"])
            })
        })
    }),

    notion: Object.freeze({
        id: "notion",
        displayName: "Notion",
        authUrl: "https://api.notion.com/v1/oauth/authorize",
        tokenUrl: "https://api.notion.com/v1/oauth/token",
        revokeUrl: null,
        scopeSeparator: " ",
        tokenAuth: "basic",
        extraAuthorizeParams: Object.freeze({ owner: "user" }),
        baseScopes: Object.freeze([]), // Notion: kapabilitas dipilih di layar consent, bukan scope.
        services: null
    }),

    slack: Object.freeze({
        id: "slack",
        displayName: "Slack",
        authUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        revokeUrl: "https://slack.com/api/auth.revoke",
        scopeSeparator: ",",
        tokenAuth: "body",
        extraAuthorizeParams: Object.freeze({}),
        baseScopes: Object.freeze(["channels:read", "channels:history", "chat:write"]),
        services: null
    }),

    github: Object.freeze({
        id: "github",
        displayName: "GitHub",
        authUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        revokeUrl: null,
        scopeSeparator: " ",
        tokenAuth: "body",
        extraAuthorizeParams: Object.freeze({}),
        baseScopes: Object.freeze(["repo", "read:user"]),
        services: null
    }),

    spotify: Object.freeze({
        id: "spotify",
        displayName: "Spotify",
        authUrl: "https://accounts.spotify.com/authorize",
        tokenUrl: "https://accounts.spotify.com/api/token",
        revokeUrl: null,
        scopeSeparator: " ",
        tokenAuth: "basic",
        extraAuthorizeParams: Object.freeze({ show_dialog: "false" }),
        baseScopes: Object.freeze([
            "user-read-playback-state",
            "user-modify-playback-state",
            "playlist-read-private",
            "playlist-modify-public",
            "playlist-modify-private"
        ]),
        services: null
    }),

    todoist: Object.freeze({
        id: "todoist",
        displayName: "Todoist",
        authUrl: "https://todoist.com/oauth/authorize",
        tokenUrl: "https://todoist.com/oauth/access_token",
        revokeUrl: null,
        scopeSeparator: ",",
        tokenAuth: "body",
        extraAuthorizeParams: Object.freeze({}),
        baseScopes: Object.freeze(["data:read_write", "data:delete"]),
        services: null
    })
});

/** Server suite. Urutan = urutan tampil di Dashboard. */
const SERVERS = Object.freeze([

    Object.freeze({
        id: "google-workspace",
        displayName: "Google Workspace",
        description: "Gmail, Google Drive, dan Google Calendar dalam satu login Google.",
        authType: "oauth2",
        provider: "google",
        services: Object.freeze(["gmail", "drive", "calendar"]),
        tools: Object.freeze([
            tool("gmail_list_messages", "read", "Daftar pesan Gmail (id + pengirim/subjek/tanggal).", S({ query: str("Query pencarian Gmail (opsional)"), maxResults: num("Maks pesan (default 10)") }), { service: "gmail" }),
            tool("gmail_get_message", "read", "Baca isi lengkap satu pesan Gmail.", S({ id: str("ID pesan") }, ["id"]), { service: "gmail" }),
            tool("gmail_send_message", "write", "Kirim email baru lewat Gmail.", S({ to: str("Alamat tujuan"), subject: str("Subjek"), body: str("Isi email (teks)") }, ["to", "subject", "body"]), { service: "gmail" }),
            tool("gmail_trash_message", "write", "Pindahkan pesan Gmail ke sampah.", S({ id: str("ID pesan") }, ["id"]), { service: "gmail" }),
            tool("drive_list_files", "read", "Daftar berkas Google Drive.", S({ query: str("Query Drive (opsional)"), pageSize: num("Maks berkas (default 20)") }), { service: "drive" }),
            tool("drive_get_file", "read", "Metadata satu berkas Drive.", S({ id: str("ID berkas") }, ["id"]), { service: "drive" }),
            tool("drive_download_text", "read", "Unduh isi berkas Drive sebagai teks.", S({ id: str("ID berkas"), maxBytes: num("Batas byte (default 65536)") }, ["id"]), { service: "drive" }),
            tool("drive_upload_file", "write", "Unggah berkas teks baru ke Drive.", S({ name: str("Nama berkas"), contentText: str("Isi teks"), mimeType: str("MIME (default text/plain)"), folderId: str("ID folder tujuan (opsional)") }, ["name", "contentText"]), { service: "drive" }),
            tool("drive_create_folder", "write", "Buat folder baru di Drive.", S({ name: str("Nama folder"), parentId: str("ID folder induk (opsional)") }, ["name"]), { service: "drive" }),
            tool("drive_delete_file", "write", "Hapus berkas Drive (ke sampah Drive).", S({ id: str("ID berkas") }, ["id"]), { service: "drive" }),
            tool("calendar_list_events", "read", "Daftar acara Google Calendar yang akan datang.", S({ calendarId: str("ID kalender (default primary)"), maxResults: num("Maks acara (default 10)") }), { service: "calendar" }),
            tool("calendar_create_event", "write", "Buat acara baru di Google Calendar.", S({ summary: str("Judul acara"), start: str("Mulai (RFC3339)"), end: str("Selesai (RFC3339)"), description: str("Deskripsi (opsional)"), calendarId: str("ID kalender (default primary)") }, ["summary", "start", "end"]), { service: "calendar" }),
            tool("calendar_delete_event", "write", "Hapus acara dari Google Calendar.", S({ eventId: str("ID acara"), calendarId: str("ID kalender (default primary)") }, ["eventId"]), { service: "calendar" })
        ])
    }),

    Object.freeze({
        id: "microsoft-365",
        displayName: "Microsoft 365",
        description: "Outlook Mail, OneDrive, dan Outlook Calendar dalam satu login Microsoft.",
        authType: "oauth2",
        provider: "microsoft",
        services: Object.freeze(["mail", "drive", "calendar"]),
        tools: Object.freeze([
            tool("outlook_list_messages", "read", "Daftar pesan Outlook terbaru.", S({ maxResults: num("Maks pesan (default 10)") }), { service: "mail" }),
            tool("outlook_get_message", "read", "Baca isi satu pesan Outlook.", S({ id: str("ID pesan") }, ["id"]), { service: "mail" }),
            tool("outlook_send_message", "write", "Kirim email baru lewat Outlook.", S({ to: str("Alamat tujuan"), subject: str("Subjek"), body: str("Isi email (teks)") }, ["to", "subject", "body"]), { service: "mail" }),
            tool("onedrive_list_files", "read", "Daftar berkas di root OneDrive.", S({}), { service: "drive" }),
            tool("onedrive_download_text", "read", "Unduh isi berkas OneDrive sebagai teks.", S({ id: str("ID item"), maxBytes: num("Batas byte (default 65536)") }, ["id"]), { service: "drive" }),
            tool("onedrive_upload_file", "write", "Unggah berkas teks ke OneDrive.", S({ name: str("Nama berkas"), contentText: str("Isi teks") }, ["name", "contentText"]), { service: "drive" }),
            tool("ms_calendar_list_events", "read", "Daftar acara Outlook Calendar yang akan datang.", S({ maxResults: num("Maks acara (default 10)") }), { service: "calendar" }),
            tool("ms_calendar_create_event", "write", "Buat acara baru di Outlook Calendar.", S({ subject: str("Judul acara"), start: str("Mulai (ISO, tanpa zona — UTC)"), end: str("Selesai (ISO, tanpa zona — UTC)"), body: str("Isi (opsional)") }, ["subject", "start", "end"]), { service: "calendar" })
        ])
    }),

    Object.freeze({
        id: "notion",
        displayName: "Notion",
        description: "Cari, baca, dan tulis halaman serta database Notion.",
        authType: "oauth2",
        provider: "notion",
        services: null,
        tools: Object.freeze([
            tool("notion_search", "read", "Cari halaman/database Notion.", S({ query: str("Kata kunci (opsional)") })),
            tool("notion_get_page", "read", "Baca properti satu halaman Notion.", S({ pageId: str("ID halaman") }, ["pageId"])),
            tool("notion_list_databases", "read", "Daftar database Notion yang dapat diakses.", S({})),
            tool("notion_query_database", "read", "Query baris sebuah database Notion.", S({ databaseId: str("ID database"), pageSize: num("Maks baris (default 20)") }, ["databaseId"])),
            tool("notion_create_page", "write", "Buat halaman Notion baru.", S({ parentPageId: str("ID halaman induk"), title: str("Judul"), contentText: str("Isi awal (opsional)") }, ["parentPageId", "title"])),
            tool("notion_append_text", "write", "Tambahkan paragraf teks ke halaman/blok Notion.", S({ blockId: str("ID halaman/blok"), text: str("Teks") }, ["blockId", "text"]))
        ])
    }),

    Object.freeze({
        id: "slack",
        displayName: "Slack",
        description: "Baca riwayat channel Slack dan kirim pesan.",
        authType: "oauth2",
        provider: "slack",
        services: null,
        tools: Object.freeze([
            tool("slack_list_channels", "read", "Daftar channel Slack yang diikuti bot.", S({})),
            tool("slack_get_history", "read", "Riwayat pesan terakhir sebuah channel.", S({ channel: str("ID channel"), limit: num("Maks pesan (default 20)") }, ["channel"])),
            tool("slack_post_message", "write", "Kirim pesan ke channel Slack.", S({ channel: str("ID channel"), text: str("Isi pesan") }, ["channel", "text"]))
        ])
    }),

    Object.freeze({
        id: "github",
        displayName: "GitHub",
        description: "Repo, issue, dan pull request GitHub.",
        authType: "oauth2",
        provider: "github",
        services: null,
        tools: Object.freeze([
            tool("github_list_repos", "read", "Daftar repo GitHub pengguna.", S({ pageSize: num("Maks repo (default 20)") })),
            tool("github_get_repo", "read", "Detail satu repo GitHub.", S({ owner: str("Pemilik"), repo: str("Nama repo") }, ["owner", "repo"])),
            tool("github_list_issues", "read", "Daftar issue sebuah repo.", S({ owner: str("Pemilik"), repo: str("Nama repo"), state: str("open|closed|all (default open)") }, ["owner", "repo"])),
            tool("github_get_issue", "read", "Detail satu issue.", S({ owner: str("Pemilik"), repo: str("Nama repo"), number: num("Nomor issue") }, ["owner", "repo", "number"])),
            tool("github_list_pull_requests", "read", "Daftar pull request sebuah repo.", S({ owner: str("Pemilik"), repo: str("Nama repo"), state: str("open|closed|all (default open)") }, ["owner", "repo"])),
            tool("github_create_issue", "write", "Buat issue baru.", S({ owner: str("Pemilik"), repo: str("Nama repo"), title: str("Judul"), body: str("Isi (opsional)") }, ["owner", "repo", "title"])),
            tool("github_create_comment", "write", "Komentari sebuah issue/PR.", S({ owner: str("Pemilik"), repo: str("Nama repo"), number: num("Nomor issue/PR"), body: str("Isi komentar") }, ["owner", "repo", "number", "body"]))
        ])
    }),

    Object.freeze({
        id: "spotify",
        displayName: "Spotify",
        description: "Kontrol pemutaran dan playlist Spotify.",
        authType: "oauth2",
        provider: "spotify",
        services: null,
        tools: Object.freeze([
            tool("spotify_get_playback", "read", "Status pemutaran Spotify saat ini.", S({})),
            tool("spotify_list_playlists", "read", "Daftar playlist Spotify pengguna.", S({ pageSize: num("Maks playlist (default 20)") })),
            tool("spotify_get_playlist", "read", "Detail + daftar lagu sebuah playlist.", S({ id: str("ID playlist") }, ["id"])),
            tool("spotify_play", "write", "Putar / lanjutkan pemutaran Spotify.", S({})),
            tool("spotify_pause", "write", "Jeda pemutaran Spotify.", S({})),
            tool("spotify_next", "write", "Lewati ke lagu berikutnya.", S({})),
            tool("spotify_previous", "write", "Kembali ke lagu sebelumnya.", S({})),
            tool("spotify_create_playlist", "write", "Buat playlist Spotify baru.", S({ name: str("Nama playlist"), description: str("Deskripsi (opsional)") }, ["name"])),
            tool("spotify_add_to_playlist", "write", "Tambahkan lagu ke playlist.", S({ playlistId: str("ID playlist"), trackUris: { type: "array", items: { type: "string" }, description: "URI lagu (spotify:track:...)" } }, ["playlistId", "trackUris"]))
        ])
    }),

    Object.freeze({
        id: "todoist",
        displayName: "Todoist",
        description: "Daftar tugas Todoist: lihat, buat, selesaikan.",
        authType: "oauth2",
        provider: "todoist",
        services: null,
        tools: Object.freeze([
            tool("todoist_list_tasks", "read", "Daftar tugas aktif Todoist.", S({})),
            tool("todoist_create_task", "write", "Buat tugas Todoist baru.", S({ content: str("Isi tugas"), dueString: str("Jatuh tempo natural, mis. 'besok' (opsional)") }, ["content"])),
            tool("todoist_complete_task", "write", "Tandai tugas Todoist selesai.", S({ id: str("ID tugas") }, ["id"])),
            tool("todoist_delete_task", "write", "Hapus tugas Todoist.", S({ id: str("ID tugas") }, ["id"]))
        ])
    }),

    Object.freeze({
        id: "blender",
        displayName: "Blender",
        description: "Jembatan lokal ke Blender yang sedang berjalan (tanpa login).",
        authType: "local",
        provider: null,
        services: null,
        tools: Object.freeze([
            tool("blender_get_scene_info", "read", "Info scene Blender aktif (objek, kamera, render).", S({})),
            tool("blender_list_objects", "read", "Daftar objek dalam scene Blender.", S({})),
            tool("blender_get_object_info", "read", "Detail transform satu objek Blender.", S({ name: str("Nama objek") }, ["name"])),
            tool("blender_set_object_transform", "write", "Ubah lokasi/rotasi/skala objek Blender.", S({ name: str("Nama objek"), location: { type: "array", items: { type: "number" }, description: "[x,y,z] (opsional)" }, rotation: { type: "array", items: { type: "number" }, description: "Euler radian [x,y,z] (opsional)" }, scale: { type: "array", items: { type: "number" }, description: "[x,y,z] (opsional)" } }, ["name"])),
            tool("blender_render_image", "write", "Render scene Blender ke berkas gambar.", S({ filepath: str("Jalur keluaran absolut (.png)") }, ["filepath"]))
        ])
    }),

    Object.freeze({
        id: "filesystem",
        displayName: "Berkas Lokal",
        description: "Baca/tulis berkas HANYA di folder yang diberikan pengguna (tanpa login).",
        authType: "local",
        provider: null,
        services: null,
        tools: Object.freeze([
            tool("fs_list_dir", "read", "Daftar isi sebuah folder yang diberikan akses.", S({ path: str("Jalur folder") }, ["path"])),
            tool("fs_read_text", "read", "Baca berkas teks di folder yang diberikan akses.", S({ path: str("Jalur berkas"), maxBytes: num("Batas byte (default 65536)") }, ["path"])),
            tool("fs_write_text", "write", "Tulis/ganti berkas teks di folder yang diberikan akses.", S({ path: str("Jalur berkas"), content: str("Isi teks") }, ["path", "content"])),
            tool("fs_create_directory", "write", "Buat folder baru di dalam folder yang diberikan akses.", S({ path: str("Jalur folder baru") }, ["path"])),
            tool("fs_delete_path", "write", "Hapus berkas/folder di dalam folder yang diberikan akses.", S({ path: str("Jalur yang dihapus") }, ["path"]))
        ])
    }),

    Object.freeze({
        id: "web",
        displayName: "Web",
        description: "Ambil halaman web sebagai teks dan cari di web (tanpa login).",
        authType: "none",
        provider: null,
        services: null,
        tools: Object.freeze([
            tool("web_fetch", "read", "Ambil URL dan kembalikan teks yang dapat dibaca.", S({ url: str("URL http/https"), maxChars: num("Batas karakter (default 20000)") }, ["url"])),
            tool("web_search", "read", "Cari di web; kembalikan judul, URL, dan cuplikan.", S({ query: str("Kata kunci"), maxResults: num("Maks hasil (default 5)") }, ["query"]))
        ])
    })
]);

const SERVER_BY_ID = new Map(SERVERS.map(s => [s.id, s]));
const PROVIDER_BY_ID = new Map(Object.values(OAUTH_PROVIDERS).map(p => [p.id, p]));

/** Server → provider OAuth-nya (atau null). */
function providerForServer(serverId) {
    const server = SERVER_BY_ID.get(serverId);
    if (!server?.provider) return null;
    return PROVIDER_BY_ID.get(server.provider) ?? null;
}

/** Semua nama tool tier "write" (untuk pemetaan riskCatalog + tes). */
function writeToolNames() {
    const out = [];
    for (const s of SERVERS) for (const t of s.tools) if (t.tier === "write") out.push(t.name);
    return out;
}

/** Scope OAuth yang diminta untuk server, mengikuti layanan aktif. */
function scopesForServer(serverId, enabledServices = null) {
    const provider = providerForServer(serverId);
    if (!provider) return [];
    const scopes = new Set(provider.baseScopes);
    if (provider.services) {
        const active = enabledServices ?? Object.keys(provider.services);
        for (const key of active) {
            const svc = provider.services[key];
            if (svc) for (const sc of svc.scopes) scopes.add(sc);
        }
    }
    return [...scopes];
}

/** Deskriptor publik untuk Dashboard/docs (tanpa fungsi, aman JSON). */
function publicDescriptor(server) {
    return {
        id: server.id,
        displayName: server.displayName,
        description: server.description,
        authType: server.authType,
        provider: server.provider,
        services: server.services
            ? server.services.map(key => ({ key, label: OAUTH_PROVIDERS[server.provider].services[key].label }))
            : null,
        tools: server.tools.map(t => ({
            name: t.name,
            tier: t.tier,
            description: t.description,
            ...(t.service ? { service: t.service } : {})
        }))
    };
}

module.exports = {
    OAUTH_PROVIDERS,
    SERVERS,
    SERVER_BY_ID,
    PROVIDER_BY_ID,
    providerForServer,
    scopesForServer,
    writeToolNames,
    publicDescriptor
};
