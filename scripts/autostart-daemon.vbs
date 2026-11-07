' Peluncur senyap daemon Damar.
'
' Dipanggil Scheduled Task "Damar Daemon" saat login. Tanpa pembungkus
' ini, node akan memunculkan jendela konsol hitam setiap kali PC menyala.
' Angka 0 pada .Run = jendela disembunyikan; False = tidak menunggu.
'
' Jalur repo sengaja dibaca dari lokasi skrip ini, jadi tetap benar
' walau repo dipindahkan.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

sh.CurrentDirectory = repo
sh.Run "node src\server.js", 0, False
