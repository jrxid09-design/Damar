/**
 * RE Intelligence — parser statis PE (Portable Executable), bounded.
 *
 * ATURAN KEAMANAN:
 * - Artifact dianggap HOSTILE. Semua offset/panjang dari file dicek
 *   batasnya SEBELUM dibaca; tidak ada alokasi berbasis field penyerang.
 * - Parser murni membaca buffer di memori — TIDAK PERNAH mengeksekusi
 *   apa pun, TIDAK memanggil proses eksternal.
 * - Struktur mustahil (offset keluar batas, ukuran negatif, table yang
 *   tidak masuk akal) → diagnostic + hasil parsial, bukan crash.
 *
 * Yang DIDUKUNG V0 (dokumentasi eksplisit batas):
 * - DOS header + PE signature, COFF header, optional header PE32/PE32+,
 *   section table, import directory (nama DLL + fungsi), export names,
 *   subsystem, entry point, machine/architecture, karakteristik.
 * - Resource tree, delay-load imports, .NET metadata: TIDAK didukung V0.
 *
 * Timestamp COFF disimpan sebagai METADATA saja — tidak dipercaya
 * sebagai kronologi (bisa dipalsukan bebas).
 */

"use strict";

const { freezeDeep } = require("../model/model");

const MACHINE_NAMES = Object.freeze({
    0x014c: "x86",
    0x8664: "x64",
    0x01c0: "arm",
    0xaa64: "arm64",
    0x01c4: "armnt"
});

const SUBSYSTEM_NAMES = Object.freeze({
    1: "native",
    2: "windows_gui",
    3: "windows_cui",
    5: "os2_cui",
    7: "posix_cui",
    9: "windows_ce_gui",
    10: "efi_application",
    11: "efi_boot_driver",
    12: "efi_runtime_driver",
    13: "efi_rom",
    14: "xbox"
});

const SECTION_FLAGS = Object.freeze({
    0x00000020: "CODE",
    0x00000040: "INITIALIZED_DATA",
    0x00000080: "UNINITIALIZED_DATA",
    0x02000000: "DISCARDABLE",
    0x04000000: "NOT_CACHED",
    0x10000000: "SHARED",
    0x20000000: "EXECUTE",
    0x40000000: "READ",
    0x80000000: "WRITE"
});

const DOS_HEADER_SIZE = 64;
const COFF_HEADER_SIZE = 20;
const SECTION_HEADER_SIZE = 40;
const IMPORT_DESCRIPTOR_SIZE = 20;

function u16(buf, off) {
    return buf.readUInt16LE(off);
}

function u32(buf, off) {
    return buf.readUInt32LE(off);
}

/** Baca ASCII null-terminated dengan batas ketat. null jika tak valid. */
function readAsciiZ(buf, offset, maxLen = 512) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= buf.length) {
        return null;
    }
    const end = Math.min(offset + maxLen, buf.length);
    let i = offset;
    while (i < end && buf[i] !== 0) i++;
    if (i >= end) return null; // tak ada terminator dalam batas → tolak
    const s = buf.toString("latin1", offset, i);
    // Karakter kontrol (kecuali yang lazim) → anggap bukan nama valid.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return null;
    return s;
}

/** Flag apakah buffer tampak PE (MZ + signature PE\0\0 pada e_lfanew). */
function looksLikePe(buf) {
    return probePeHeader(buf).ok;
}

/**
 * Probe header PE dengan range-check PENUH — aman untuk artifact hostile.
 * Tidak pernah melempar; setiap pembacaan fixed-offset diverifikasi batasnya
 * SEBELUM dibaca. Dipakai identifikasi agar MZ terpotong tidak menyebabkan
 * RangeError pada pembacaan karakteristik COFF.
 */
function probePeHeader(buf) {
    try {
        if (!buf || buf.length < DOS_HEADER_SIZE) {
            return { ok: false, reason: "too-short" };
        }
        if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
            return { ok: false, reason: "no-mz" };
        }
        const lfaNew = u32(buf, 0x3c);
        if (!Number.isInteger(lfaNew) ||
            lfaNew < DOS_HEADER_SIZE ||
            lfaNew + 4 + COFF_HEADER_SIZE > buf.length) {   // COFF utuh wajib muat
            return { ok: false, reason: "coff-out-of-range" };
        }
        const sigOff = lfaNew;
        if (!(buf[sigOff] === 0x50 && buf[sigOff + 1] === 0x45 &&
              buf[sigOff + 2] === 0 && buf[sigOff + 3] === 0)) {
            return { ok: false, reason: "no-pe-sig" };
        }
        // Karakteristik COFF berada di sigOff(+4 ukuran signature) + 18.
        const characteristics = u16(buf, sigOff + 4 + 18);
        return {
            ok: true,
            isDll: (characteristics & 0x2000) !== 0,
            characteristics
        };
    } catch {
        // Pertahanan terakhir: byte hostile tidak boleh mengganggu identifikasi.
        return { ok: false, reason: "probe-error" };
    }
}

/** Varian offset — untuk pemindaian embedded artifact. */
function looksLikePeAt(buf, base) {
    if (!buf || buf.length < base + DOS_HEADER_SIZE) return false;
    if (buf[base] !== 0x4d || buf[base + 1] !== 0x5a) return false;
    const lfaNew = u32(buf, base + 0x3c);
    if (lfaNew < DOS_HEADER_SIZE || base + lfaNew + 4 > buf.length) return false;
    const sigOff = base + lfaNew;
    return buf[sigOff] === 0x50 && buf[sigOff + 1] === 0x45 &&
        buf[sigOff + 2] === 0 && buf[sigOff + 3] === 0;
}

/**
 * Parse PE penuh. Selalu mengembalikan objek { ok, ... } — tidak pernah
 * melempar. Kegagalan tercatat sebagai diagnostic dengan kode jelas.
 */
function parsePe(buffer, limits) {
    const diagnostics = [];
    const diag = (code, message) => diagnostics.push({ code, message });

    if (!looksLikePe(buffer)) {
        return { ok: false, diagnostics: [
            { code: "PE_NOT_PE", message: "buffer bukan PE (MZ/PE signature)" }
        ] };
    }

    const peOff = u32(buffer, 0x3c);

    // ---- COFF header -------------------------------------------------
    if (peOff + 4 + COFF_HEADER_SIZE > buffer.length) {
        diag("PE_TRUNCATED", "COFF header melewati akhir file");
        return { ok: false, diagnostics };
    }
    const coffOff = peOff + 4;
    const machineRaw = u16(buffer, coffOff);
    const numberOfSections = u16(buffer, coffOff + 2);
    const timestamp = u32(buffer, coffOff + 4);          // metadata saja
    const sizeOfOptionalHeader = u16(buffer, coffOff + 16);
    const characteristics = u16(buffer, coffOff + 18);
    const isDll = (characteristics & 0x2000) !== 0;

    // ---- Optional header ---------------------------------------------
    // SizeOfOptionalHeader adalah BATAS NYATA: setiap pembacaan field
    // wajib berada di dalam [optOff, optEnd) DAN di dalam buffer.
    const optOff = coffOff + COFF_HEADER_SIZE;
    const optEnd = optOff + sizeOfOptionalHeader;
    if (sizeOfOptionalHeader < 2 || optEnd > buffer.length) {
        diag("PE_TRUNCATED", "optional header melewati akhir file");
        return { ok: false, diagnostics };
    }

    const optMagic = u16(buffer, optOff);
    let pe32Plus;
    if (optMagic === 0x20b) pe32Plus = true;
    else if (optMagic === 0x10b) pe32Plus = false;
    else {
        diag("PE_BAD_STRUCTURE", `magic optional header tak dikenal: 0x${optMagic.toString(16)}`);
        return { ok: false, diagnostics };
    }

    // Bagian tetap minimum sebelum data directory (PE32+: 112, PE32: 96).
    const minOptFixed = pe32Plus ? 112 : 96;
    /** Field pada offset relatif optOff valid hanya jika muat dalam batas ganda. */
    const canReadOpt = (relOffset, len) =>
        relOffset >= 0 &&
        optOff + relOffset + len <= optEnd &&          // dalam declared header
        optOff + relOffset + len <= buffer.length;     // dalam buffer

    if (!canReadOpt(minOptFixed - 4, 4)) {
        diag("PE_TRUNCATED",
            `SizeOfOptionalHeader=${sizeOfOptionalHeader} terlalu kecil untuk field wajib ${pe32Plus ? "PE32+" : "PE32"} (butuh >= ${minOptFixed})`);
        return { ok: false, diagnostics };
    }
    if (!canReadOpt(16, 4)) {
        diag("PE_TRUNCATED", "AddressOfEntryPoint di luar batas optional header");
        return { ok: false, diagnostics };
    }
    if (!canReadOpt(68, 2)) {
        diag("PE_TRUNCATED", "Subsystem di luar batas optional header");
        return { ok: false, diagnostics };
    }

    const addressOfEntryPoint = u32(buffer, optOff + 16);
    const subsystemRaw = u16(buffer, optOff + 68);
    const numberOfRvaAndSizes = canReadOpt(pe32Plus ? 108 : 92, 4)
        ? u32(buffer, optOff + (pe32Plus ? 108 : 92))
        : 0;
    const dataDirsOff = optOff + minOptFixed;
    const dataDirSize = 8;

    const dataDirs = [];
    let maxDataDirs = Math.min(numberOfRvaAndSizes, 16);
    const dirsLimit = Math.min(optEnd, buffer.length);
    if (dataDirsOff + maxDataDirs * dataDirSize > dirsLimit) {
        const fits = Math.max(0,
            Math.floor((dirsLimit - dataDirsOff) / dataDirSize));
        diag("PE_TRUNCATED",
            `data directory terpotong: ${maxDataDirs} dideklarasikan, hanya ${fits} muat`);
        maxDataDirs = Math.min(maxDataDirs, fits);
    }
    for (let i = 0; i < maxDataDirs; i++) {
        const dOff = dataDirsOff + i * dataDirSize;
        if (dOff + dataDirSize > buffer.length) break;   // pertahanan ganda
        dataDirs.push({
            name: DATA_DIR_NAMES[i] ?? `dir_${i}`,
            rva: u32(buffer, dOff),
            size: u32(buffer, dOff + 4)
        });
    }

    // ---- Section table -----------------------------------------------
    const sectionsOff = optOff + sizeOfOptionalHeader;
    const sectionCount = Math.min(numberOfSections, limits.maxSections);
    if (numberOfSections > limits.maxSections) {
        diag("BUDGET_LIMIT_REACHED",
            `jumlah section ${numberOfSections} melebihi batas ${limits.maxSections}; sisanya diabaikan`);
    }
    if (sectionsOff + numberOfSections * SECTION_HEADER_SIZE > buffer.length) {
        diag("PE_TRUNCATED", "section table melewati akhir file");
        return { ok: false, diagnostics };
    }

    const fileSize = buffer.length;
    const sections = [];
    for (let i = 0; i < sectionCount; i++) {
        const so = sectionsOff + i * SECTION_HEADER_SIZE;
        let rawName = "";
        for (let c = 0; c < 8; c++) {
            const ch = buffer[so + c];
            if (ch === 0) break;
            rawName += String.fromCharCode(ch);
        }
        const virtualSize = u32(buffer, so + 8);
        const virtualAddress = u32(buffer, so + 12);
        const sizeOfRawData = u32(buffer, so + 16);
        const pointerToRawData = u32(buffer, so + 20);
        const flagsRaw = u32(buffer, so + 36);
        const flags = Object.keys(SECTION_FLAGS)
            .filter((f) => (flagsRaw & Number(f)) !== 0)
            .map((f) => SECTION_FLAGS[f]);

        const beyondEof = sizeOfRawData > 0 &&
            (pointerToRawData > fileSize ||
             pointerToRawData + sizeOfRawData > fileSize);

        sections.push({
            name: rawName,
            virtualSize,
            virtualAddress,
            sizeOfRawData,
            pointerToRawData,
            beyondEof,
            flags
        });
    }

    /** Konversi RVA → offset file memakai section table. null jika tak terpetakan. */
    function rvaToOffset(rva) {
        if (!Number.isInteger(rva) || rva < 0) return null;
        for (const s of sections) {
            const va = s.virtualAddress;
            const vsize = Math.max(s.virtualSize, s.sizeOfRawData);
            if (rva >= va && rva < va + vsize) {
                const delta = rva - va;
                if (delta >= s.sizeOfRawData) return null; // di virtual padding saja
                const off = s.pointerToRawData + delta;
                if (off >= fileSize) return null;
                return off;
            }
        }
        return null;
    }

    function safeAsciiAtRva(rva, maxLen) {
        if (rva <= 0) return null;
        const off = rvaToOffset(rva);
        if (off === null) return null;
        return readAsciiZ(buffer, off, maxLen);
    }

    // ---- Import directory --------------------------------------------
    const imports = [];
    const importDir = dataDirs.find((d) => d.name === "import_table");
    if (importDir && (importDir.rva > 0 || importDir.size > 0)) {
        let descOff = rvaToOffset(importDir.rva);
        if (descOff === null) {
            diag("PE_BAD_OFFSET", `RVA import directory tak terpetakan: 0x${importDir.rva.toString(16)}`);
        } else {
            for (let i = 0; i < limits.maxImportDlls; i++) {
                const eo = descOff + i * IMPORT_DESCRIPTOR_SIZE;
                if (eo + IMPORT_DESCRIPTOR_SIZE > fileSize) {
                    diag("PE_TRUNCATED", "import descriptor melewati akhir file");
                    break;
                }
                const originalFirstThunk = u32(buffer, eo);
                const nameRva = u32(buffer, eo + 12);
                const firstThunk = u32(buffer, eo + 16);
                if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;

                if (imports.length >= limits.maxImports) {
                    diag("BUDGET_LIMIT_REACHED", "batas import tercapai; sisanya diabaikan");
                    break;
                }
                const dllName = safeAsciiAtRva(nameRva, 512);
                if (dllName === null) {
                    diag("PE_BAD_OFFSET", `nama DLL import tak terbaca (RVA 0x${nameRva.toString(16)})`);
                    continue;
                }
                imports.push({ dll: dllName, functions: [] });
                // isi functions untuk entri terakhir:
                const thunkRva = originalFirstThunk !== 0 ? originalFirstThunk : firstThunk;
                const entry = imports[imports.length - 1];
                let toff = rvaToOffset(thunkRva);
                if (toff === null) {
                    diag("PE_BAD_OFFSET", `thunk array ${dllName} tak terpetakan`);
                    continue;
                }
                const ordinalFlag = pe32Plus
                    ? 0x8000000000000000n : 0x80000000n;
                const tsize = pe32Plus ? 8 : 4;
                for (let t = 0; t < limits.maxImports; t++) {
                    // Validasi pembacaan ITERASI INI: toff + (t+1)*tsize.
                    // Guard lama (toff + tsize) hanya mengamati iterasi 0 —
                    // array thunk yang mencapai EOF tanpa terminator
                    // membaca di luar batas.
                    const readEnd = toff + (t + 1) * tsize;
                    if (!Number.isSafeInteger(readEnd) || readEnd > fileSize) {
                        diag("PE_TRUNCATED",
                            `array thunk ${dllName} mencapai akhir file tanpa terminator; hasil parsial dipertahankan`);
                        break;
                    }
                    let thunkVal, isOrdinal, targetRva;
                    const readAt = toff + t * tsize;
                    if (pe32Plus) {
                        thunkVal = buffer.readBigUInt64LE(readAt);
                        isOrdinal = (thunkVal & ordinalFlag) !== 0n;
                        targetRva = Number(thunkVal & 0x7fffffffn);
                    } else {
                        thunkVal = BigInt(u32(buffer, readAt));
                        isOrdinal = (thunkVal & ordinalFlag) !== 0n;
                        targetRva = Number(thunkVal & 0x7fffffffn);
                    }
                    if (thunkVal === 0n) break;
                    if (entry.functions.length >= limits.maxImports) {
                        diag("BUDGET_LIMIT_REACHED", `batas fungsi import ${dllName} tercapai`);
                        break;
                    }
                    if (isOrdinal) {
                        entry.functions.push(`#ordinal${targetRva}`);
                    } else {
                        // hint (2 byte) lalu nama.
                        const noff = rvaToOffset(targetRva);
                        const fname = noff === null
                            ? null
                            : readAsciiZ(buffer, noff + 2, 512);
                        entry.functions.push(fname ?? "<unreadable>");
                    }
                }
            }
        }
    }

    // ---- Export directory ---------------------------------------------
    const exportsInfo = { dllName: null, functions: [], truncated: false };
    const exportDir = dataDirs.find((d) => d.name === "export_table");
    if (exportDir && (exportDir.rva > 0 || exportDir.size > 0)) {
        const eoff = rvaToOffset(exportDir.rva);
        if (eoff === null || eoff + 40 > fileSize) {
            diag("PE_BAD_OFFSET", "export directory tak terpetakan / terpotong");
        } else {
            exportsInfo.dllName = readAsciiZ(
                buffer, rvaToOffset(u32(buffer, eoff + 12)) ?? -1, 512);
            const numberOfNames = u32(buffer, eoff + 24);
            const addressOfNames = u32(buffer, eoff + 32);
            const count = Math.min(numberOfNames, limits.maxExports);
            if (numberOfNames > limits.maxExports) {
                exportsInfo.truncated = true;
                diag("BUDGET_LIMIT_REACHED", "batas export tercapai; sisanya diabaikan");
            }
            const namesOff = rvaToOffset(addressOfNames);
            if (namesOff === null) {
                diag("PE_BAD_OFFSET", "array nama export tak terpetakan");
            } else {
                for (let i = 0; i < count; i++) {
                    const ptrOff = namesOff + i * 4;
                    if (ptrOff + 4 > fileSize) {
                        diag("PE_TRUNCATED", "array nama export terpotong");
                        break;
                    }
                    const name = safeAsciiAtRva(u32(buffer, ptrOff), 512);
                    if (name === null) {
                        diag("PE_BAD_OFFSET", `nama export #${i} tak terbaca`);
                        continue;
                    }
                    exportsInfo.functions.push(name);
                }
            }
        }
    }

    const archName = MACHINE_NAMES[machineRaw] ?? `unknown_0x${machineRaw.toString(16)}`;
    const subsystem = SUBSYSTEM_NAMES[subsystemRaw] ?? `unknown_${subsystemRaw}`;

    return freezeDeep({
        ok: true,
        diagnostics,
        format: "pe",
        architecture: archName,
        machineRaw,
        pe32Plus,
        isDll,
        subsystem,
        entryPoint: addressOfEntryPoint,
        imageBase: pe32Plus
            ? "0x" + buffer.readBigUInt64LE(optOff + 24).toString(16)
            : "0x" + u32(buffer, optOff + 28).toString(16),
        /** Metadata mentah — BUKAN kronologi tepercaya. */
        timestampField: timestamp,
        characteristics: characteristics,
        sections,
        imports,
        exports: exportsInfo,
        dataDirectories: dataDirs.filter((d) => d.rva !== 0 || d.size !== 0)
    });
}

const DATA_DIR_NAMES = Object.freeze([
    "export_table", "import_table", "resource_table", "exception_table",
    "certificate_table", "base_relocation_table", "debug", "architecture",
    "global_ptr", "tls_table", "load_config_table", "bound_import",
    "iat", "delay_import_descriptor", "com_runtime_descriptor", "reserved"
]);

module.exports = {
    parsePe, looksLikePe, looksLikePeAt, probePeHeader, readAsciiZ, MACHINE_NAMES
};
