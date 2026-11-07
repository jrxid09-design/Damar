// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  async execute(args){
    const fs = require('fs');
    const path = require('path');
    const p = String(args.path||'').trim();
    if(!p) throw new Error('parameter path wajib diisi');
    if(!fs.existsSync(p)) throw new Error('file tidak ditemukan: '+p);
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase().replace('.','');
    const mimeMap = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp'};
    const mime = mimeMap[ext] || 'image/png';
    const dataUrl = 'data:'+mime+';base64,'+buf.toString('base64');
    const sizeKb = Math.round(buf.length/1024);
    if(args.maxChars){
      const mc = parseInt(args.maxChars,10);
      if(dataUrl.length > mc) throw new Error('dataUrl '+dataUrl.length+' karakter melebihi maxChars '+mc+' — kecilkan gambar dulu (lebar/kompresi)');
    }
    return { ok:true, path:p, mime:mime, sizeKb:sizeKb, dataUrlLength:dataUrl.length, dataUrl:dataUrl };
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "IMAGETODATAURL";
        this.description = "Mengatasi bug show_image blank putih di Console: webview menolak sumber file:// dan http:// lokal, tapi menerima data URL. Skill ini membaca file gambar lokal (png/jpg/webp/gif/bmp) dan mengembalikan data URL base64 siap pakai untuk show_image.";
        this.parameters = {
    path: {"type":"string","description":"Path file gambar lokal, mis. C:\\AetherGenesis\\AetherSelf\\shot.png","required":true},
    maxChars: {"type":"number","description":"Batas panjang dataUrl (opsional); error bila lebih, sebagai pengaman payload","required":false}
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
