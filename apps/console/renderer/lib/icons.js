/**
 * Ikon Aether — bahasa visual orbital & geometri berlian.
 *
 * Console harus jalan sepenuhnya offline (dan di PC rumah tanpa
 * internet), jadi tidak ada icon font atau CDN — semuanya SVG
 * stroke 1.6px dengan viewBox 24 agar konsisten di segala ukuran.
 *
 * Bahasa ikon KANONIK (selaras avatar & hologram):
 *   - berlian/diamond  → inti kognitif, identitas Aether
 *   - orbit/arc        → relasi, siaran, konektivitas
 *   - heksagon         → sistem, processing
 *   - node jaringan    → memori & pengetahuan
 */

const paths = {

    /* ---- Ikon APLIKASI (registry + launcher) ---------------------- */

    // Beranda — inti Aether: diamond + orbit + tick kardinal.
    orb: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2 16.8 12 12 16.8 7.2 12Z"/><path d="M12 3.4v1.7M12 18.9v1.7M3.4 12h1.7M18.9 12h1.7"/>',

    // Aether (chat) — inti berlian memancarkan busur siaran.
    chat: '<path d="M12 6.6 17.4 12 12 17.4 6.6 12Z"/><path d="M8.7 3.9a8.6 8.6 0 0 0 0 16.2M15.3 3.9a8.6 8.6 0 0 1 0 16.2"/>',

    // Memori — inti berlapis (berlian dalam berlian): pengetahuan.
    memory: '<path d="M12 3 21 12l-9 9-9-9Z"/><path d="M12 7.5 16.5 12 12 16.5 7.5 12Z"/><path d="M12 10.7 13.3 12 12 13.3 10.7 12Z"/>',

    // Jaringan pengetahuan (graf) — dipakai panel memory graph.
    brain: '<circle cx="12" cy="12" r="2.2"/><circle cx="5" cy="6.5" r="1.8"/><circle cx="19" cy="6.5" r="1.8"/><circle cx="5" cy="17.5" r="1.8"/><circle cx="19" cy="17.5" r="1.8"/><path d="M6.5 7.7 10.3 10.7M17.5 7.7 13.7 10.7M6.5 16.3 10.3 13.3M17.5 16.3 13.7 13.3"/>',

    // Model AI — chip heksagonal dengan inti berlian.
    cpu: '<path d="M12 4 19 8v8l-7 4-7-4V8Z"/><path d="M12 8.4 15.6 12 12 15.6 8.4 12Z"/><path d="M12 4V2M19 8l1.8-1M19 16l1.8 1M12 20v2M5 16l-1.8 1M5 8 3.2 7"/>',

    // Studio — grid asimetris dengan satu sel berlian (kreativitas).
    grid: '<rect x="3.8" y="3.8" width="7.4" height="7.4" rx="1.2"/><path d="M15.9 12.9 20.2 17.2 15.9 21.5 11.6 17.2Z"/><rect x="3.8" y="13.2" width="7.4" height="7.4" rx="1.2"/><rect x="13.2" y="3.8" width="7.4" height="7.4" rx="1.2"/>',

    // Kesadaran — radar konsentris: persepsi lingkungan.
    activity: '<circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="12" r="5.4"/><circle cx="12" cy="12" r="9"/><path d="M12 12 17.6 6.4"/>',

    // Ruang — rumah dengan inti berlian di dalam.
    home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5"/><path d="M12 12.4 14.6 15 12 17.6 9.4 15Z"/>',

    // Terhubung — steker konduitor (tetap, sudah teknis).
    plug: '<path d="M9 3v6M15 3v6"/><path d="M6.5 9h11v3a5.5 5.5 0 0 1-11 0V9Z"/><path d="M12 17.5V21"/>',

    // OSINT — pencarian dengan lensa berlian.
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path d="M11 8.2 13.8 11 11 13.8 8.2 11Z"/>',

    // Ikhtisar — bento asimetris.
    dashboard: '<rect x="3" y="3" width="7.5" height="8.5" rx="1.2"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.2"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.2"/><rect x="3" y="14.5" width="7.5" height="6.5" rx="1.2"/>',

    // Runtime — terminal chevron.
    terminal: '<rect x="2.8" y="4" width="18.4" height="16" rx="1.6"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',

    // Log — bel sistem.
    bell: '<path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 5 2 6.5 2 6.5h-15S6.5 14 6.5 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>',

    // Keamanan — perisai heksagonal dengan inti berlian.
    shield: '<path d="M12 3 19.5 6.2v5.3c0 4.5-3.1 8.3-7.5 9.5-4.4-1.2-7.5-5-7.5-9.5V6.2Z"/><path d="M12 8.6 15 12l-3 3.4L9 12Z"/>',

    // Pengaturan — orbit pengaturan (roda → planet + satelit).
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6.2 6.2l1.6 1.6M16.2 16.2l1.6 1.6M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6"/>',

    /* ---- Ikon utilitas --------------------------------------------- */

    mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21M9 21h6"/>',

    camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-2h6l1.2 2h1.8A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5Z"/><circle cx="12" cy="13" r="3.4"/>',

    box: '<path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7Z"/><path d="M3.5 7 12 11.4 20.5 7M12 11.4V21.2"/>',

    tool: '<path d="M14.7 6.3a4.5 4.5 0 0 0 5.9 5.9l-8.4 8.4a2.4 2.4 0 0 1-3.4-3.4Z"/><path d="m17.5 3.5 3 3-2 2-3-3Z"/>',

    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9.1a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.37Z"/>',

    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',

    play: '<path d="M7.5 4.8 19 12 7.5 19.2Z"/>',

    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',

    send: '<path d="m4 12 16-8-5.5 16-3-6.5Z"/><path d="m11.5 13.5 8.5-9.5"/>',

    trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5 7.5 20h9l1-13.5"/>',

    plus: '<path d="M12 5v14M5 12h14"/>',

    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',

    x: '<path d="M6 6l12 12M18 6 6 18"/>',

    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',

    folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/>',

    file: '<path d="M6 3.5h7l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13 3.5v5h5"/>',

    download: '<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4 17v2a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2"/>',

    server: '<rect x="3" y="4" width="18" height="6.5" rx="1.4"/><rect x="3" y="13.5" width="18" height="6.5" rx="1.4"/><path d="M7 7.2h.01M7 16.8h.01"/>',

    cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95 5.5 5.5 0 0 0-10.6-1.2A3.75 3.75 0 0 0 7 18.5Z"/>',

    sensor: '<circle cx="12" cy="12" r="2.5"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 15.8a5.4 5.4 0 0 0 0-7.6"/><path d="M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 18.5a9.2 9.2 0 0 0 0-13"/>',

    minimize: '<path d="M5 12h14"/>',

    maximize: '<rect x="5" y="5" width="14" height="14" rx="1.6"/>',

    restore: '<rect x="4.5" y="7.5" width="12" height="12" rx="1.6"/><path d="M8 7.5V6a1.5 1.5 0 0 1 1.5-1.5H18A1.5 1.5 0 0 1 19.5 6v8.5A1.5 1.5 0 0 1 18 16h-1.5"/>',

    close: '<path d="M6 6l12 12M18 6 6 18"/>',

    alert: '<path d="M12 8.5v5M12 17h.01"/><path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',

    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.3 6.5"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.7-1.7"/>',
    flask: '<path d="M9.5 3h5M10.5 3v5.2L4.9 17.6A2 2 0 0 0 6.6 20.6h10.8a2 2 0 0 0 1.7-3L13.5 8.2V3"/><path d="M7.5 14.5h9"/>',

    "chevron-left": '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'

};

/** Kembalikan markup SVG untuk sebuah ikon. */
export function icon(name, className = "icon") {

    const body = paths[name];

    if (!body) {
        return "";
    }

    return `<svg class="${className}" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"
        aria-hidden="true">${body}</svg>`;

}

/** Lambang Aether: berlian berlapis — gradasi kanonik cyan→violet. */
export function brandMark(size = 20) {

    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <defs>
            <linearGradient id="aether-mark" x1="0" y1="0" x2="24" y2="24">
                <stop offset="0%" stop-color="#00DFFF"/>
                <stop offset="100%" stop-color="#7C5CFF"/>
            </linearGradient>
        </defs>
        <path d="M12 1.6 22.4 12 12 22.4 1.6 12Z" stroke="url(#aether-mark)" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M12 6.4 17.6 12 12 17.6 6.4 12Z" fill="url(#aether-mark)" opacity="0.85"/>
    </svg>`;
}
