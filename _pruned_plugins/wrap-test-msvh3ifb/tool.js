class Tool {
    constructor() {
        this.name = "wrapTest";
        this.description = "Uji pembungkusan kode class polos menjadi modul plugin yang diekspor sebagai array instance.";
        this.parameters = {
    inp: {"type":"string","description":"inp","required":true}
        };
    }
 async execute(a){ return { echo: a.inp }; } }
module.exports = [new Tool()];
