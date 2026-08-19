class Tool {
    constructor() {
        this.name = "wrapTest2";
        this.description = "Uji pembungkusan kode class polos menjadi modul plugin array instance dan sandbox eksekusi.";
        this.parameters = {
    inp: {"type":"string","description":"inp","required":true}
        };
    }
 async execute(a){ return { echo: a.inp, len: String(a.inp).length }; } }
module.exports = [new Tool()];
