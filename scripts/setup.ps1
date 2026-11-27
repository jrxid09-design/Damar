#Requires -Version 5.1
# Bootstrapper pemasangan Damar dari sumber (git clone) — SATU perintah
# setelah clone:
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# Skrip ini sengaja ditulis dalam PowerShell murni (bukan Node) karena
# ia harus bisa jalan di PC yang BELUM punya Node.js sama sekali:
# bila Node >= 20 tidak ditemukan di PATH maupun di data\tools\node,
# Node.js portable resmi (versi yang sama dengan yang dibundel
# installer produk, hash dipin dari SHASUMS256 resmi nodejs.org)
# diunduh ke data\tools\node — folder Damar sendiri, tanpa admin,
# tanpa mengubah sistem. Setelah itu kendali diserahkan ke
# scripts\setup-cli.js yang menjalankan audit penuh, provision
# sisanya (Python portable dsb.), pemasangan dependensi, unduhan
# model voice, pendaftaran perintah `damar`, shortcut, dan laporan
# preflight (data\setup-report.json).
#
# Semua argumen diteruskan ke setup-cli.js (mis. --skip-voice).

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NodeDir = Join-Path $Root 'data\tools\node'
$PortableNode = Join-Path $NodeDir 'node.exe'
$PinVersion = '24.19.0'
$PinSha256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'

function Get-NodeMajor([string]$Exe, [string[]]$PrefixArgs) {
    try {
        $v = & $Exe @PrefixArgs --version 2>$null
        if ($v -match 'v(\d+)\.') { return [int]$Matches[1] }
    } catch { }
    return 0
}

$nodeExe = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd -and (Get-NodeMajor $cmd.Source @()) -ge 20) { $nodeExe = $cmd.Source }
elseif ((Test-Path $PortableNode) -and (Get-NodeMajor $PortableNode @()) -ge 20) { $nodeExe = $PortableNode }

if (-not $nodeExe) {
    Write-Host "setup: Node.js >= 20 tidak ditemukan - mengunduh Node.js portable resmi v$PinVersion..."
    $tools = Join-Path $Root 'data\tools'
    New-Item -ItemType Directory -Force $tools | Out-Null
    $zip = Join-Path $tools "node-v$PinVersion-win-x64.zip"
    curl.exe -L --fail --retry 3 -o $zip "https://nodejs.org/dist/v$PinVersion/node-v$PinVersion-win-x64.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Unduhan Node.js gagal. Periksa koneksi internet, lalu jalankan lagi.' }
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $PinSha256) { Remove-Item $zip -Force; throw "SHA-256 Node.js tidak cocok dengan pin resmi: $hash" }
    $tmp = Join-Path $tools '_extract'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip $tmp -Force
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item (Join-Path $tmp "node-v$PinVersion-win-x64") $NodeDir
    Remove-Item -Recurse -Force $tmp
    Remove-Item $zip -Force
    $nodeExe = $PortableNode
    Write-Host "setup: Node.js portable siap di $NodeDir"
}

& $nodeExe (Join-Path $Root 'scripts\setup-cli.js') @args
exit $LASTEXITCODE
