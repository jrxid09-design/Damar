/** Pembantu DOM & pemformatan yang dipakai semua view. */

export const $ = (selector, scope = document) => scope.querySelector(selector);

export const $$ = (selector, scope = document) =>
    [...scope.querySelectorAll(selector)];

/** Escape untuk teks apa pun yang masuk ke innerHTML. */
export function esc(value) {

    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

}

export function el(tag, attrs = {}, html = "") {

    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {

        if (key === "class") {
            node.className = value;
        }
        else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        }
        else if (value !== null && value !== undefined) {
            node.setAttribute(key, value);
        }

    }

    if (html) {
        node.innerHTML = html;
    }

    return node;

}

// ---- Pemformatan ------------------------------------------------

export function bytes(value) {

    if (!Number.isFinite(value) || value <= 0) {
        return "—";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];

    let index = 0;
    let size = value;

    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index++;
    }

    return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;

}

export function duration(seconds) {

    if (!Number.isFinite(seconds)) {
        return "—";
    }

    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);

    // "d" dipakai untuk hari, jadi detik disingkat "dtk" agar
    // tidak ambigu pada gabungan seperti "18m 29dtk".
    if (d) return `${d}h ${h}j`;
    if (h) return `${h}j ${m}m`;
    if (m) return `${m}m ${s}dtk`;

    return `${s}dtk`;

}

export function clockTime(iso) {

    try {
        return new Date(iso).toLocaleTimeString("id-ID", { hour12: false });
    }
    catch {
        return "--:--:--";
    }

}

export function relativeTime(iso) {

    if (!iso) {
        return "belum pernah";
    }

    const delta = (Date.now() - new Date(iso).getTime()) / 1000;

    if (delta < 5) return "baru saja";
    if (delta < 60) return `${Math.floor(delta)} detik lalu`;
    if (delta < 3600) return `${Math.floor(delta / 60)} menit lalu`;
    if (delta < 86400) return `${Math.floor(delta / 3600)} jam lalu`;

    return `${Math.floor(delta / 86400)} hari lalu`;

}

/** Potong teks pada batas kata untuk pratinjau di tabel. */
export function truncateText(value, limit = 60) {

    const text = String(value ?? "").trim();

    if (text.length <= limit) {
        return text;
    }

    const cut = text.slice(0, limit);

    const lastSpace = cut.lastIndexOf(" ");

    return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;

}

// ---- Pil status --------------------------------------------------

export function pill(text, tone = "idle") {

    return `<span class="pill ${tone}"><span class="dot"></span>${esc(text)}</span>`;

}

export function statusPill(online, { onlineText = "Online", offlineText = "Offline", disabled = false } = {}) {

    if (disabled) {
        return pill("Nonaktif", "idle");
    }

    return online
        ? pill(onlineText, "ok")
        : pill(offlineText, "danger");

}

// ---- Toast --------------------------------------------------------

let toastHost = null;

export function toast(message, tone = "ok", ttl = 3600) {

    if (!toastHost) {
        toastHost = el("div", { class: "toasts" });
        document.body.appendChild(toastHost);
    }

    const node = el("div", { class: `toast ${tone}` }, esc(message));

    toastHost.appendChild(node);

    setTimeout(() => {

        node.classList.add("leaving");

        setTimeout(() => node.remove(), 220);

    }, ttl);

    return node;

}

// ---- Grafik kecil --------------------------------------------------

/**
 * Cincin gauge. `value` dalam persen (0..100).
 * Warna berubah mengikuti ambang agar beban tinggi langsung terlihat.
 */
export function gauge(value, label = "") {

    const clamped = Math.max(0, Math.min(100, Number(value) || 0));

    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - clamped / 100);

    const color =
        clamped >= 88 ? "var(--danger)" :
        clamped >= 70 ? "var(--warn)" :
        "var(--accent-1)";

    return `<div class="gauge" title="${esc(label)}">
        <svg width="96" height="96" viewBox="0 0 96 96">
            <circle class="track-ring" cx="48" cy="48" r="${radius}" fill="none" stroke-width="7"/>
            <circle class="value-ring" cx="48" cy="48" r="${radius}" fill="none" stroke-width="7"
                stroke="${color}"
                stroke-dasharray="${circumference.toFixed(1)}"
                stroke-dashoffset="${offset.toFixed(1)}"/>
        </svg>
        <div class="readout">${clamped.toFixed(0)}<span style="font-size:12px">%</span></div>
    </div>`;

}

/** Sparkline dari deret angka 0..100. */
export function sparkline(values, { height = 40, stroke = "var(--accent-1)" } = {}) {

    if (!values || values.length < 2) {
        return `<svg class="sparkline" viewBox="0 0 100 ${height}" preserveAspectRatio="none"></svg>`;
    }

    const max = Math.max(100, ...values);

    const step = 100 / (values.length - 1);

    const points = values.map((value, index) => {
        const x = index * step;
        const y = height - (value / max) * (height - 4) - 2;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    const line = points.join(" ");

    const area = `0,${height} ${line} 100,${height}`;

    return `<svg class="sparkline" viewBox="0 0 100 ${height}" preserveAspectRatio="none">
        <defs>
            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${stroke}" stop-opacity="0.32"/>
                <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
            </linearGradient>
        </defs>
        <polygon points="${area}" fill="url(#spark-fill)"/>
        <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.6"
            vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;

}

// ---- Aneka ----------------------------------------------------------

export function debounce(fn, wait = 250) {

    let timer = null;

    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };

}

/**
 * Render Markdown minimal: blok kode, kode inline, tebal, miring.
 * Sengaja tidak memakai pustaka penuh — keluaran model di sini
 * hanya perlu terbaca rapi, bukan HTML lengkap.
 */
export function markdown(text) {

    let html = esc(text);

    html = html.replace(
        /```(\w*)\n?([\s\S]*?)```/g,
        (match, lang, code) =>
            `<pre><code data-lang="${esc(lang)}">${code.replace(/\n$/, "")}</code></pre>`
    );

    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

    html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    return html;

}
