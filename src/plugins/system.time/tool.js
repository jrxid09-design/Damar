/**
 * Waktu sekarang.
 *
 * Dulu hanya mengembalikan `new Date().toISOString()` — selalu UTC,
 * tanpa penanda zona apa pun. Model membacanya sebagai jam setempat
 * dan menjawab "18:22" ketika di sini baru pukul 01:22, kadang
 * bahkan melabelinya "WIB". Salah tujuh jam, dan disampaikan dengan
 * yakin — lebih buruk daripada tidak menjawab.
 *
 * Sekarang waktu lokal disajikan lebih dulu dan zona waktunya
 * disebutkan. `time` tetap ISO/UTC supaya pemakai lama tidak
 * berubah artinya.
 */
class TimeTool {

    constructor() {
        this.name = "currentTime";
        this.description =
            "Waktu dan tanggal sekarang di mesin ini, dalam zona waktu lokal " +
            "(jam, pukul, hari, tanggal). Get the current local date and time.";
    }

    async execute(context, args) {

        const now = new Date();

        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        return {

            // Inilah yang dimaksud pengguna saat bertanya "jam berapa".
            local: now.toLocaleString("id-ID", {
                dateStyle: "full",
                timeStyle: "short"
            }),

            timeZone: zone,

            // Selisih terhadap UTC dalam menit, positif ke arah timur.
            offsetMinutes: -now.getTimezoneOffset(),

            note: `Jawab pengguna memakai waktu lokal (${zone}), bukan UTC.`,

            // UTC, untuk keperluan mesin. Nama lama dipertahankan.
            time: now.toISOString()

        };

    }

}

module.exports = TimeTool;
