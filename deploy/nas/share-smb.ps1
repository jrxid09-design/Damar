# Aktifkan share SMB folder NAS agar bisa diakses dari iPhone/perangkat lain.
# JALANKAN SEBAGAI ADMINISTRATOR (klik kanan > Run with PowerShell as Admin),
# atau: powershell -ExecutionPolicy Bypass -File share-smb.ps1 -Pool "D:\DamarNAS"
#
# Setelah selesai, di iPhone: app Files > (...) > Connect to Server >
#   smb://<IP-PC>/DamarNAS  > login akun Windows-mu.

param(
    [string]$Pool = "D:\DamarNAS",
    [string]$ShareName = "DamarNAS"
)

if (-not (Test-Path $Pool)) {
    New-Item -ItemType Directory -Path $Pool -Force | Out-Null
    Write-Host "Folder dibuat: $Pool"
}

if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
    Write-Host "Share '$ShareName' sudah ada."
}
else {
    New-SmbShare -Name $ShareName -Path $Pool -FullAccess "$env:USERDOMAIN\$env:USERNAME" | Out-Null
    Write-Host "Share dibuat: \\$env:COMPUTERNAME\$ShareName  ->  $Pool"
}

# Izinkan File and Printer Sharing di firewall (jaringan lokal).
Enable-NetFirewallRule -DisplayGroup "File and Printer Sharing" -ErrorAction SilentlyContinue

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" } |
    Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "Selesai. Dari iPhone (app Files > Connect to Server):"
Write-Host "  smb://$ip/$ShareName"
