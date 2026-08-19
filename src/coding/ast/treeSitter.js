const path = require("node:path");
const fs = require("node:fs");

/**
 * treeSitter — mesin AST internal Aether (Coding Brain, Fase 3).
 *
 * Parser UTAMA source code = Tree-sitter (WASM via web-tree-sitter +
 * grammar prebuilt tree-sitter-wasms). AST = SUMBER KEBENARAN; JANGAN
 * parsing kode dengan regex. Tanpa native build → aman lintas-OS.
 * Degradasi anggun bila paket belum ada.
 */

const EXT_LANG = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx", py: "python", go: "go", rs: "rust",
    cs: "c_sharp", java: "java", rb: "ruby", php: "php", c: "c", h: "c",
    cpp: "cpp", cc: "cpp", hpp: "cpp", cxx: "cpp", json: "json",
    css: "css", html: "html", sh: "bash", bash: "bash", lua: "lua"
};

let _Parser, _Language, _ready = false;
const _langCache = new Map();

function wasmDir() {
    return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

async function ensure() {
    if (_ready) return;
    const mod = require("web-tree-sitter");
    _Parser = mod.Parser ?? mod.default ?? mod;                 // dukung API baru & lama
    await _Parser.init();
    // Di web-tree-sitter 0.22, namespace Language baru ada SETELAH init().
    _Language = mod.Language ?? _Parser.Language;
    _ready = true;
}

async function loadLang(name) {
    if (_langCache.has(name)) return _langCache.get(name);
    const p = path.join(wasmDir(), `tree-sitter-${name}.wasm`);
    if (!fs.existsSync(p)) throw new Error(`Grammar tak tersedia: ${name}`);
    const lang = await _Language.load(p);
    _langCache.set(name, lang);
    return lang;
}

function langNameOf(fileOrLang) {
    const s = String(fileOrLang || "");
    if (Object.values(EXT_LANG).includes(s)) return s;          // sudah nama bahasa
    const ext = s.split(".").pop().toLowerCase();
    return EXT_LANG[ext] ?? null;
}

const INTEREST = /(class|function|method|interface|struct|enum|module|trait|impl|type|constructor|arrow_function|namespace|field|variable)/i;
const DEFINITION = /(declaration|definition|_item|_specifier|class|function|method|arrow_function|interface|struct|enum|type_alias|namespace|constructor)/i;
const NAMEISH = /(identifier|property_identifier|type_identifier|field_identifier|name)/i;

class TreeSitter {

    async available() { try { await ensure(); return true; } catch { return false; } }

    languages() { return [...new Set(Object.values(EXT_LANG))]; }

    /** Parse kode → { tree, lang }. */
    async parse(code, fileOrLang) {
        await ensure();
        const name = langNameOf(fileOrLang);
        if (!name) throw new Error(`Bahasa tak dikenali untuk: ${fileOrLang}`);
        const lang = await loadLang(name);
        const parser = new _Parser();
        parser.setLanguage(lang);
        return { tree: parser.parse(code), lang: name };
    }

    /**
     * Outline simbol dari AST (kelas/fungsi/method/interface/…) dengan
     * baris & kedalaman. Berbasis AST, bukan regex.
     */
    async symbols(code, fileOrLang, { maxDepth = 5 } = {}) {
        const { tree, lang } = await this.parse(code, fileOrLang);
        const out = [];
        const walk = (node, depth) => {
            if (depth > maxDepth) return;
            for (const child of node.namedChildren) {
                if (INTEREST.test(child.type) && DEFINITION.test(child.type)) {
                    let name = child.childForFieldName?.("name")?.text;
                    if (!name) {
                        const id = child.namedChildren.find(c => NAMEISH.test(c.type));
                        name = id?.text;
                    }
                    if (name) out.push({ kind: child.type, name, line: child.startPosition.row + 1, depth });
                }
                walk(child, depth + 1);
            }
        };
        walk(tree.rootNode, 0);
        return { lang, count: out.length, symbols: out };
    }

    /** Outline dari sebuah file di disk. */
    async symbolsOfFile(file, opts) {
        const code = fs.readFileSync(file, "utf8");
        return this.symbols(code, file, opts);
    }

}

module.exports = new TreeSitter();
