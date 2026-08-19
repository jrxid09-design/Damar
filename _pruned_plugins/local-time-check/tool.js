class Tool {
  constructor() {
    this.name = 'getLocalTime';
    this.description = 'Mengambil waktu lokal perangkat saat ini dari jam sistem, termasuk tanggal, jam, zona waktu, dan offset UTC.';
    this.parameters = {
      format: { type: 'string', description: 'Format keluaran: iso, readable, atau both (default).', required: false }
    };
  }
  async execute(args) {
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][now.getDay()];
      const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][now.getMonth()];
      const readable = hari + ', ' + now.getDate() + ' ' + bulan + ' ' + now.getFullYear() + ' pukul ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
      const offsetMin = -now.getTimezoneOffset();
      const sign = offsetMin >= 0 ? '+' : '-';
      const offset = 'UTC' + sign + pad(Math.floor(Math.abs(offsetMin) / 60)) + ':' + pad(Math.abs(offsetMin) % 60);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
      const hasil = {
        iso: now.toISOString(),
        readable: readable,
        timezone: tz,
        offset: offset,
        unix: Math.floor(now.getTime() / 1000)
      };
      return { ok: true, hasil: hasil };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
}
module.exports = [new Tool()];
