// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  constructor() {
    this.name = 'sendImmichPhotoByAssetId';
    this.description = 'Mengirim foto dari Immich berdasarkan asset_id yang telah ditemukan sebelumnya ke percakapan WhatsApp atau Telegram.';
    this.parameters = {
      type: 'object',
      properties: {
        asset_id: {
          type: 'string',
          description: 'ID aset Immich.'
        },
        caption: {
          type: 'string',
          description: 'Keterangan opsional foto.'
        }
      },
      required: ['asset_id']
    };
  }

  async execute(args) {
    if (!args || !args.asset_id) {
      return { ok: false, error: 'Param asset_id wajib diisi.' };
    }
    try {
      const assetId = String(args.asset_id);
      const caption = args.caption ? String(args.caption) : '';
      return {
        ok: true,
        asset_id: assetId,
        caption: caption,
        message: `Foto dengan asset_id ${assetId} berhasil disiapkan untuk dikirim.`
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "SENDIMMICHPHOTOBYASSETID";
        this.description = "Mengirim foto dari Immich berdasarkan asset_id yang telah ditemukan sebelumnya ke percakapan WhatsApp atau Telegram atau platform yang aktif.";
        this.parameters = {
    asset_id: {"type":"string","description":"ID aset foto atau media dari Immich yang ingin dikirim.","required":true},
    caption: {"type":"string","description":"Keterangan atau teks pendamping untuk foto yang dikirim.","required":false}
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
