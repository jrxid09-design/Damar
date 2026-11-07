/**
 * Fixture generator PE minimal & deterministik untuk tes RE Intelligence.
 *
 * Menghasilkan struktur PE valid yang BENIGN — dibangun dari nol di sini,
 * bukan binary nyata dari luar. Mendukung PE32+ dan PE32, import table,
 * export table, dan opsi korupsi terkontrol untuk pengujian kegagalan aman.
 */

"use strict";

const FILE_ALIGN = 0x200;
const SECTION_RVA = 0x1000;

/**
 * @param {object} opts
 *   machine        - 0x8664 (default), 0x14c, ...
 *   pe32Plus       - true (default) → PE32+, false → PE32
 *   isDll          - characteristics bit 0x2000
 *   timestamp      - nilai field timestamp (metadata fixture)
 *   subsystem      - default 3 (console)
 *   entryPoint     - RVA entry point (default SECTION_RVA)
 *   imports        - [{ dll: "KERNEL32.dll", functions: ["CreateFileW"] }]
 *   exports        - { moduleName: "fix.dll", functions: ["ExpOne"] }
 */
function buildPe(opts = {}) {
    const {
        machine = 0x8664,
        pe32Plus = true,
        isDll = false,
        timestamp = 0x65000000,
        subsystem = 3,
        entryPoint = SECTION_RVA,
        imports = [],
        exports = null
    } = opts;

    const tsize = pe32Plus ? 8 : 4;
    const optHeaderSize = (pe32Plus ? 112 : 96) + 16 * 8;
    const peOff = 0x80;
    const sectionsOff = peOff + 4 + 20 + optHeaderSize;
    const headersSize = sectionsOff + 1 * 40;              // 1 section
    const rawStart = alignUp(headersSize, FILE_ALIGN);

    // ---- alokator isi section -------------------------------------------
    // cursor relatif terhadap awal raw section; RVA = SECTION_RVA + cursor
    const body = [];
    let cursor = 0;
    function place(bytes) {
        const off = cursor;
        body.push([off, bytes]);
        cursor += bytes.length;
        return off;
    }
    const rvaOf = (off) => SECTION_RVA + off;

    function asciiZ(s) {
        return Buffer.from(s + "\0", "latin1");
    }

    // ---- susun isi section: import structures ----------------------------
    const importDescriptors = [];
    let importDirCursor = null;

    if (imports.length > 0) {
        importDirCursor = cursor;

        // string nama DLL + hint/name + thunk arrays ditempatkan duluan,
        // lalu descriptor array ditulis setelahnya agar ukurannya pasti.
        const perDll = [];
        for (const imp of imports) {
            const nameOff = place(asciiZ(imp.dll));
            const thunks = [];
            for (const fn of imp.functions) {
                const hnameOff = place(Buffer.from([0, 0]));           // hint
                place(asciiZ(fn));
                thunks.push(rvaOf(hnameOff));
            }
            const thunkArrOff = place(
                Buffer.alloc((thunks.length + 1) * tsize));            // + null terminator
            perDll.push({ nameRva: rvaOf(nameOff), thunkRva: rvaOf(thunkArrOff), thunks });
        }
        const descSize = (imports.length + 1) * 20;
        const descOff = place(Buffer.alloc(descSize));

        // isi thunk arrays
        for (let i = 0; i < imports.length; i++) {
            const p = perDll[i];
            for (let t = 0; t < p.thunks.length; t++) {
                const val = p.thunks[t];
                if (pe32Plus) {
                    body.find(([o]) => o === p.thunkRva - SECTION_RVA)[1]
                        .writeBigUInt64LE(BigInt(val), t * 8);
                } else {
                    body.find(([o]) => o === p.thunkRva - SECTION_RVA)[1]
                        .writeUInt32LE(val >>> 0, t * 4);
                }
            }
        }
        // isi descriptor array
        const descBuf = body.find(([o]) => o === descOff)[1];
        for (let i = 0; i < imports.length; i++) {
            const base = i * 20;
            descBuf.writeUInt32LE(perDll[i].thunkRva, base);      // OriginalFirstThunk
            descBuf.writeUInt32LE(0, base + 4);                   // TimeDateStamp
            descBuf.writeUInt32LE(0, base + 8);                   // ForwarderChain
            descBuf.writeUInt32LE(perDll[i].nameRva, base + 12);  // Name
            descBuf.writeUInt32LE(perDll[i].thunkRva, base + 16); // FirstThunk
        }
        importDescriptors.push({ rva: rvaOf(descOff), size: descSize });
    }

    // ---- export structures -------------------------------------------------
    let exportDirInfo = null;
    if (exports && exports.functions?.length) {
        const nf = exports.functions.length;

        // cadangkan buffer directory lebih dulu agar tidak overlap.
        const dirBuf = Buffer.alloc(40);
        const dirOff = place(dirBuf);

        const modNameOff = place(asciiZ(exports.moduleName ?? "fixture.dll"));
        const funcsArrOff = place(Buffer.alloc(nf * 4));
        const namesArrOff = place(Buffer.alloc(nf * 4));
        const ordsArrOff = place(Buffer.alloc(nf * 2));

        const nameRvas = [];
        for (const fn of exports.functions) {
            const no = place(asciiZ(fn));
            nameRvas.push(rvaOf(no));
        }
        const funcsBuf = body.find(([o]) => o === funcsArrOff)[1];
        const namesBuf = body.find(([o]) => o === namesArrOff)[1];
        const ordsBuf = body.find(([o]) => o === ordsArrOff)[1];
        for (let i = 0; i < nf; i++) {
            funcsBuf.writeUInt32LE(SECTION_RVA, i * 4);   // tunjuk awal section (dummy)
            namesBuf.writeUInt32LE(nameRvas[i], i * 4);
            ordsBuf.writeUInt16LE(i, i * 2);
        }

        dirBuf.writeUInt32LE(0, 0);                       // Flags
        dirBuf.writeUInt32LE(timestamp, 4);
        dirBuf.writeUInt32LE(0, 8);                       // Major/Minor
        dirBuf.writeUInt32LE(rvaOf(modNameOff), 12);      // Name RVA
        dirBuf.writeUInt32LE(1, 16);                      // OrdinalBase
        dirBuf.writeUInt32LE(nf, 20);                     // AddrTable entries
        dirBuf.writeUInt32LE(nf, 24);                     // NumberOfNamePointers
        dirBuf.writeUInt32LE(rvaOf(funcsArrOff), 28);
        dirBuf.writeUInt32LE(rvaOf(namesArrOff), 32);
        dirBuf.writeUInt32LE(rvaOf(ordsArrOff), 36);

        exportDirInfo = { rva: rvaOf(dirOff), size: 40 };
    }

    const rawSize = Math.max(alignUp(cursor, FILE_ALIGN), FILE_ALIGN);

    // ---- rakit file --------------------------------------------------------
    const file = Buffer.alloc(rawStart + rawSize);

    // DOS header
    file.write("MZ", 0, "latin1");
    file.writeUInt32LE(peOff, 0x3c);                       // e_lfanew

    // PE signature
    file.write("PE\0\0", peOff, "latin1");

    // COFF header
    const coff = peOff + 4;
    file.writeUInt16LE(machine, coff);
    file.writeUInt16LE(1, coff + 2);                       // NumberOfSections
    file.writeUInt32LE(timestamp, coff + 4);
    file.writeUInt32LE(0, coff + 8);                       // Ptr symtab
    file.writeUInt32LE(0, coff + 12);                      // Num symbols
    file.writeUInt16LE(optHeaderSize, coff + 16);
    file.writeUInt16LE(isDll ? 0x2022 : 0x0022, coff + 18);// characteristics

    // Optional header
    const opt = coff + 20;
    file.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, opt);
    file[opt + 2] = 14; file[opt + 3] = 29;                // linker version
    file.writeUInt32LE(entryPoint, opt + 16);
    if (pe32Plus) {
        file.writeBigUInt64LE(0x140000000n, opt + 24);     // ImageBase
    } else {
        file.writeUInt32LE(0x400000, opt + 28);            // ImageBase
    }
    file.writeUInt32LE(0x1000, opt + 32);                  // SectionAlignment
    file.writeUInt32LE(FILE_ALIGN, opt + 36);              // FileAlignment
    file.writeUInt32LE(0x2000, opt + 56);                  // SizeOfImage
    file.writeUInt32LE(rawStart, opt + 60);                // SizeOfHeaders
    file.writeUInt16LE(subsystem, opt + 68);
    file.writeUInt32LE(16, opt + (pe32Plus ? 108 : 92));   // NumberOfRvaAndSizes

    const dirs = opt + (pe32Plus ? 112 : 96);
    if (exportDirInfo) {
        file.writeUInt32LE(exportDirInfo.rva, dirs + 0);
        file.writeUInt32LE(exportDirInfo.size, dirs + 4);
    }
    if (importDescriptors.length) {
        const d = importDescriptors[0];
        file.writeUInt32LE(d.rva, dirs + 8);               // index 1
        file.writeUInt32LE(d.size, dirs + 12);
    }

    // Section header ".idata"
    const so = sectionsOff;
    file.write(".idata", so, "latin1");
    file.writeUInt32LE(cursor || 0x10, so + 8);            // VirtualSize
    file.writeUInt32LE(SECTION_RVA, so + 12);              // VirtualAddress
    file.writeUInt32LE(rawSize, so + 16);                  // SizeOfRawData
    file.writeUInt32LE(rawStart, so + 20);                 // PointerToRawData
    file.writeUInt32LE(0xc0000040, so + 36);               // INIT_DATA|READ|WRITE

    // Isi raw section
    for (const [off, bytes] of body) bytes.copy(file, rawStart + off);

    return file;
}

function alignUp(v, a) {
    return Math.ceil(v / a) * a;
}

/** Variasi korupsi terkontrol untuk pengujian kegagalan aman. */
function corrupt(buffer, mode) {
    const copy = Buffer.from(buffer);
    switch (mode) {
        case "truncate-half":
            return copy.subarray(0, copy.length >> 1);
        case "bad-e-lfanew":                    // menunjuk keluar file
            copy.writeUInt32LE(0xfffffff0, 0x3c);
            return copy;
        case "absurd-thunk-rva":
            // RVA OriginalFirstThunk entri import pertama → 0xffffff00
            copy.writeUInt32LE(0xffffff00, findImportDesc(copy) + 0);
            return copy;
        case "huge-section-size":
            copy.writeUInt32LE(0xffffffff, findSectionHeader(copy) + 16);
            return copy;
        default:
            throw new Error(`mode korupsi tak dikenal: ${mode}`);
    }
}

function findPeOffset(buf) {
    return buf.readUInt32LE(0x3c);
}
function findSectionHeader(buf) {
    const peOff = findPeOffset(buf);
    return peOff + 4 + 20 + ((pe32MagicIsPlus(buf)) ? 240 : 224);
}
function pe32MagicIsPlus(buf) {
    const peOff = findPeOffset(buf);
    return buf.readUInt16LE(peOff + 4 + 20) === 0x20b;
}
function findImportDesc(buf) {
    const plus = pe32MagicIsPlus(buf);
    const peOff = findPeOffset(buf);
    const dirs = peOff + 4 + 20 + (plus ? 112 : 96);
    const importDirRva = buf.readUInt32LE(dirs + 8);
    const secOff = findSectionHeader(buf);
    const secRva = buf.readUInt32LE(secOff + 12);
    const secPtr = buf.readUInt32LE(secOff + 20);
    return secPtr + (importDirRva - secRva);
}

module.exports = { buildPe, corrupt };
