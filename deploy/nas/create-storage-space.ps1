# ============================================================
#  Buat RAID/multi-disk pool via Windows Storage Spaces.
#  !!! PERINGATAN: MENGHAPUS SELURUH DATA pada disk yang dipilih !!!
#  Jalankan SEBAGAI ADMINISTRATOR. Baca dulu, pahami, baru jalankan.
# ============================================================
#
#  1) Lihat disk yang bisa di-pool:
#       Get-PhysicalDisk -CanPool $true
#
#  2) Jalankan (contoh mirror 2 disk):
#       .\create-storage-space.ps1 -Resiliency Mirror -DriveLetter N
#
#  Resiliency:
#    Simple  = gabung kapasitas, TANPA proteksi (butuh >=1 disk)
#    Mirror  = salinan ganda, tahan 1 disk mati (butuh >=2 disk)
#    Parity  = mirip RAID5, hemat ruang (butuh >=3 disk)

param(
    [ValidateSet("Simple", "Mirror", "Parity")][string]$Resiliency = "Mirror",
    [string]$PoolName = "AetherPool",
    [string]$DiskName = "AetherVolume",
    [string]$DriveLetter = "N"
)

$disks = Get-PhysicalDisk -CanPool $true
if (-not $disks) { Write-Error "Tak ada disk yang bisa di-pool. (Disk harus kosong / tak berpartisi.)"; exit 1 }

Write-Host "Disk yang akan DIPAKAI (dan DIHAPUS):" -ForegroundColor Yellow
$disks | Format-Table FriendlyName, @{n="SizeGB";e={[math]::Round($_.Size/1GB,1)}}, MediaType

$confirm = Read-Host "Ketik 'HAPUS' untuk melanjutkan (semua data di disk itu hilang)"
if ($confirm -ne "HAPUS") { Write-Host "Dibatalkan."; exit 0 }

$subsys = (Get-StorageSubSystem)[0]
New-StoragePool -FriendlyName $PoolName -StorageSubSystemFriendlyName $subsys.FriendlyName -PhysicalDisks $disks | Out-Null
New-VirtualDisk -StoragePoolFriendlyName $PoolName -FriendlyName $DiskName -ResiliencySettingName $Resiliency -UseMaximumSize | Out-Null

$vd = Get-VirtualDisk -FriendlyName $DiskName
$vd | Get-Disk | Initialize-Disk -PartitionStyle GPT -PassThru |
    New-Partition -DriveLetter $DriveLetter -UseMaximumSize |
    Format-Volume -FileSystem NTFS -NewFileSystemLabel $DiskName -Confirm:$false | Out-Null

Write-Host "Selesai. Pool '$PoolName' ($Resiliency) → drive ${DriveLetter}:" -ForegroundColor Green
Write-Host "Di Console: NAS > Storage Manager > jadikan ${DriveLetter}: sebagai Storage Pool Aether."
