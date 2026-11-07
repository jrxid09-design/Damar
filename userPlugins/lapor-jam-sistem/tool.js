// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  constructor() {
    this.name = 'laporJamSistem';
    this.description = 'Membaca jam sistem saat ini dan mengembalikan waktu lokal terformat, zona waktu aktif, timestamp ISO UTC, dan epoch milidetik dalam objek JSON.';
    this.parameters = {
      timeZone: {
        type: 'string',
        description: 'Zona waktu IANA opsional (misal Asia/Jakarta). Default: zona waktu sistem lokal.',
        required: false
      }
    };
  }

  async execute(args) {
    const opts = args || {};
    const raw = typeof opts.timeZone === 'string' ? opts.timeZone.trim() : '';
    const zone = raw || undefined;
    const now = new Date();

    let formatter;
    try {
      formatter = new Intl.DateTimeFormat('id-ID', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: zone
      });
    } catch (e) {
      return { ok: false, error: 'Zona waktu tidak valid: ' + raw };
    }

    let parts = {};
    try {
      parts = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: zone
      }).formatToParts(now).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});
    } catch (e) {
      return { ok: false, error: 'Gagal memformat waktu untuk zona: ' + raw };
    }

    const hour = parts.hour === '24' ? '00' : parts.hour;
    const isoLokal = parts.year + '-' + parts.month + '-' + parts.day + 'T' + hour + ':' + parts.minute + ':' + parts.second;

    let zonaAktif;
    try {
      zonaAktif = zone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    } catch (e) {
      zonaAktif = 'unknown';
    }

    let offsetUtc = null;
    try {
      const offsetMinutes = -new Date(now.toLocaleString('en-US', { timeZone: zone || undefined })).getTimezoneOffset();
      if (Number.isFinite(offsetMinutes)) {
        const sign = offsetMinutes >= 0 ? '+' : '-';
        const abs = Math.abs(offsetMinutes);
        offsetUtc = 'UTC' + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
      }
    } catch (e) {
      offsetUtc = null;
    }

    return {
      ok: true,
      hasil: {
        jamSistem: formatter.format(now),
        isoLokal: isoLokal,
        isoUtc: now.toISOString(),
        epochMilidetik: now.getTime(),
        zonaWaktu: zonaAktif,
        offsetUtc: offsetUtc
      }
    };
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "LAPORJAMSISTEM";
        this.description = "Membaca jam sistem saat ini dan mengembalikan laporan lengkap berisi waktu lokal yang terformat, tanggal, zona waktu aktif, timestamp ISO UTC, serta epoch milidetik dalam satu objek JSON yang mudah dikonsumsi agen untuk keperluan pelaporan waktu sistem secara akurat.";
        this.parameters = {
    timeZone: {"type":"string","description":"Zona waktu IANA opsional (misal Asia/Jakarta). Bila diisi, waktu dihitung untuk zona tersebut; bila kosong, digunakan zona waktu sistem lokal.","required":false}
        };
    }
    // Kontrak plugin: execute(context, params).
    // Pilih sumber args yang benar: params utama; context
    // kadang membawa args saat pemanggil legacy.
    async execute(context, params) {
        const args = (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length)
            ? params
            : (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length)
                ? context
                : {};
        return this._impl.execute(args);
    }
}
module.exports = [new Tool()];
