class Tool {
  constructor() {
    this.name = 'getLocalTime';
    this.description = 'Mengembalikan waktu lokal perangkat saat ini: tanggal, jam, zona waktu, offset UTC, dan nama hari dalam Bahasa Indonesia. Tanpa jaringan, tanpa paket eksternal.';
    this.parameters = {
      format: { type: 'string', description: "Opsional: 'iso' untuk ISO 8601, 'human' untuk kalimat Bahasa Indonesia (default).", required: false }
    };
  }
  async execute(args) {
    const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const hari = HARI[now.getDay()];
    const tanggal = now.getDate() + ' ' + BULAN[now.getMonth()] + ' ' + now.getFullYear();
    const jam = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const offAbs = Math.abs(offsetMin);
    const utcOffset = 'UTC' + sign + pad(Math.floor(offAbs / 60)) + ':' + pad(offAbs % 60);
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || utcOffset;
    const human = hari + ', ' + tanggal + ' pukul ' + jam + ' (' + tzName + ', ' + utcOffset + ')';
    return {
      ok: true,
      hasil: {
        iso: now.toISOString(),
        lokal: human,
        epochMs: now.getTime(),
        hari: hari,
        tanggal: tanggal,
        jam: jam,
        zonaWaktu: tzName,
        offsetUtc: utcOffset
      }
    };
  }
}
module.exports = [new Tool()];
