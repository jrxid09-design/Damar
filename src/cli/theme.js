const chalk = require("chalk");

/**
 * Palet terminal Aether — disnap ke token KANONIK Console
 * (apps/console/renderer/styles/aether.tokens.css), bukan lagi
 * gradien cyan→ungu generik:
 *
 *   amber  #FFB84D — identitas Aether (state idle / banner)
 *   cyan   #00DFFF — aktif / sedang bekerja
 *   violet #7C5CFF — kognisi / berpikir
 *   hijau  #48E6A5 — sukses
 *   merah  #FF304F — galat
 *
 * Gaya terinspirasi opencode / gemini-cli / claude-code: header
 * blok berbingkai, spinner, prefix per-aktor, tetap tanpa DOM.
 */
const c = {
    amber:  chalk.hex("#FFB84D"),   // identitas
    gold:   chalk.hex("#FFD98A"),
    cyan:   chalk.hex("#00DFFF"),   // aktif
    cyanS:  chalk.hex("#73EDFF"),
    violet: chalk.hex("#7C5CFF"),   // kognisi
    ok:     chalk.hex("#48E6A5"),
    warn:   chalk.hex("#FFC857"),
    danger: chalk.hex("#FF304F"),
    text:   chalk.hex("#D8E7F2"),
    muted:  chalk.hex("#7890A3"),
    dim:    chalk.hex("#5E6788")
};

// Alias lama agar pemanggil yang ada tidak pecah.
c.accent = c.cyan;
c.accent2 = c.violet;
c.accent3 = c.amber;

const symbols = {
    aether: c.amber("◆"),
    you: c.cyanS("›"),
    ok: c.ok("✓"),
    warn: c.warn("!"),
    err: c.danger("✗"),
    dot: c.dim("·"),
    arrow: c.dim("→"),
    spark: c.gold("✦")
};

/**
 * Banner pembuka gaya agent-CLI modern: wordmark kecil, versi &
 * info koneksi dalam kartu berbingkai tipis — bukan ASCII besar
 * yang memakan setengah layar.
 */
function banner({ version = "", url = "", provider = "", model = "" } = {}) {

    const W = 48;

    const row = (label, value) => {
        const text = String(value ?? "");
        const cut = text.length > W - 16 ? text.slice(0, W - 17) + "…" : text;
        const pad = W - 2 - 12 - cut.length - 2;
        return c.dim("│ ") + c.muted(label.padEnd(10)) + c.text(cut) +
            c.dim(" ".repeat(Math.max(1, pad)) + "│");
    };

    const rows = [];
    if (url) rows.push(row("daemon", url));
    if (provider) rows.push(row("provider", provider));
    if (model) rows.push(row("model", model));
    if (version) rows.push(row("versi", version));

    const top = c.dim("┌" + "─".repeat(W - 2) + "┐");
    const bottom = c.dim("└" + "─".repeat(W - 2) + "┘");

    return [
        "",
        `  ${symbols.aether} ${c.amber.bold("AETHER")} ${c.muted("· personal AI daemon")}`,
        "",
        top,
        ...rows,
        bottom
    ].join("\n");
}

/** Garis pemisah ber-label. */
function hr(label = "") {
    if (!label) {
        return c.dim("  " + "─".repeat(56));
    }
    const tail = Math.max(2, 52 - String(label).length);
    return c.dim("  ── ") + c.amber(label) + " " + c.dim("─".repeat(tail));
}

/** Label status berwarna kanonik (gaya tool-step agent CLI). */
function step(iconTxt, label, detail = "") {
    return `  ${iconTxt} ${label}${detail ? " " + c.dim(detail) : ""}`;
}

module.exports = { c, symbols, banner, hr, step };
