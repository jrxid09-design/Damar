const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const pexec = promisify(execFile);
const OPTS = { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000 };

/**
 * powershellAnalyzer — dukungan PowerShell Coding Brain (P3).
 *
 * Full LSP PowerShell (PowerShell Editor Services) berat & rapuh dipasang
 * standalone. Untuk diagnostics/lint dipakai PSScriptAnalyzer — linter resmi
 * PS (yang PSES pakai di baliknya juga). Modul disimpan di lokasi milik
 * Aether (~/.aether/psmodules) & diimpor via path eksplisit (menghindari
 * jalur modul CurrentUser yang sering ter-redirect OneDrive di Windows).
 *
 * Outline simbol PS memakai PARSER AST BAWAAN PowerShell
 * ([Parser]::ParseFile) — sumber kebenaran yang sama dipakai PSES, tanpa
 * memasang PSES yang berat. Diagnostics lewat PSScriptAnalyzer.
 */

const SEVERITY = { 0: "information", 1: "warning", 2: "error", 3: "parse-error" };

function moduleManifest() {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const base = path.join(home, ".aether", "psmodules", "PSScriptAnalyzer");
    try {
        const versions = fs.readdirSync(base).filter(v => /^\d/.test(v)).sort().reverse();
        for (const v of versions) {
            const psd1 = path.join(base, v, "PSScriptAnalyzer.psd1");
            if (fs.existsSync(psd1)) return psd1;
        }
    } catch { /* belum terpasang */ }
    return null;
}

function powershellBin() {
    if (process.platform !== "win32") return "pwsh";
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return fs.existsSync(sys) ? sys : "powershell.exe";
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;   // string literal PowerShell aman

class PowerShellAnalyzer {

    available() { return !!moduleManifest(); }

    /**
     * Analisis satu file .ps1/.psm1 → diagnostics [{rule,severity,line,column,message}].
     * Degradasi anggun bila PSScriptAnalyzer belum terpasang.
     */
    async analyze(file) {
        const manifest = moduleManifest();
        if (!manifest) return { available: false, note: "PSScriptAnalyzer belum terpasang (~/.aether/psmodules)." };
        if (!fs.existsSync(file)) return { available: true, ok: false, error: `File tak ada: ${file}` };

        const script =
            `Import-Module ${psQuote(manifest)} -ErrorAction Stop; ` +
            `$r = Invoke-ScriptAnalyzer -Path ${psQuote(path.resolve(file))} -ErrorAction SilentlyContinue; ` +
            `$r | Select-Object RuleName,@{n='severity';e={[int]$_.Severity}},Line,Column,Message | ConvertTo-Json -Depth 3 -Compress`;
        try {
            const { stdout } = await pexec(powershellBin(), ["-NoProfile", "-NonInteractive", "-Command", script], OPTS);
            const out = stdout.trim();
            let raw = out ? JSON.parse(out) : [];
            if (!Array.isArray(raw)) raw = [raw];
            const diagnostics = raw.map(d => ({
                rule: d.RuleName, severity: SEVERITY[d.severity] ?? String(d.severity),
                line: d.Line, column: d.Column, message: d.Message
            }));
            return { available: true, ok: true, count: diagnostics.length, diagnostics };
        } catch (e) {
            return { available: true, ok: false, error: (e.stderr || e.message || "").slice(-2000) };
        }
    }

    /**
     * Outline simbol PS (fungsi/method/kelas/enum) via AST bawaan PowerShell.
     * Kembalian selaras dgn engine lain: { source, count, symbols:[{kind,name,line}] }.
     */
    async symbols(file) {
        if (process.platform !== "win32" && !fs.existsSync(powershellBin())) {
            return { source: "none", symbols: [], note: "PowerShell tak tersedia di OS ini." };
        }
        if (!fs.existsSync(file)) return { source: "error", symbols: [], error: `File tak ada: ${file}` };

        const script =
            `$t=$null;$e=$null;` +
            `$ast=[System.Management.Automation.Language.Parser]::ParseFile(${psQuote(path.resolve(file))},[ref]$t,[ref]$e);` +
            `$o=@();` +
            `$ast.FindAll({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)|%{$o+=[pscustomobject]@{kind='function';name=$_.Name;line=$_.Extent.StartLineNumber}};` +
            `$ast.FindAll({param($n)$n -is [System.Management.Automation.Language.TypeDefinitionAst]},$true)|%{$o+=[pscustomobject]@{kind=$(if($_.IsEnum){'enum'}elseif($_.IsClass){'class'}else{'type'});name=$_.Name;line=$_.Extent.StartLineNumber}};` +
            `$o|ConvertTo-Json -Compress`;
        try {
            const { stdout } = await pexec(powershellBin(), ["-NoProfile", "-NonInteractive", "-Command", script], OPTS);
            const out = stdout.trim();
            let raw = out ? JSON.parse(out) : [];
            if (!Array.isArray(raw)) raw = [raw];
            return { source: "powershell-ast", count: raw.length, symbols: raw };
        } catch (e) {
            return { source: "error", symbols: [], error: (e.stderr || e.message || "").slice(-2000) };
        }
    }

}

module.exports = new PowerShellAnalyzer();
