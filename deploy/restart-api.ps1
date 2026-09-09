# Restart API pengembangan.
#
# Menyasar PEMILIK PORT, bukan pola nama proses: di Windows, `pkill -f`
# kerap tidak mengenali proses node yang dijalankan lewat shell lain, dan
# instance lama tetap hidup memegang port. Instance baru gagal bind, log
# ditulis dua proses sekaligus, dan yang tampak adalah kode yang seolah
# tidak berubah padahal servernya memang belum diganti.
param([int]$Port = 3001)

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
if ($conn) {
  Write-Host "Menghentikan PID $($conn.OwningProcess) pada port $Port"
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Milliseconds 800
}

$akar = Split-Path $PSScriptRoot -Parent
$out  = Join-Path $akar 'server\dev-api.log'
$err  = Join-Path $akar 'server\dev-api.err.log'
Start-Process node -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $akar 'server') `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden
# Menunggu sampai port benar-benar mendengarkan, bukan menebak lamanya.
# Jeda tetap membuat skrip melaporkan "tidak hidup" hanya karena start-up
# kebetulan lebih lambat sedikit, dan laporan palsu itu memicu diagnosis yang
# tidak perlu.
$baru = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  $baru = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if ($baru) { break }
}
if ($baru) { Write-Host "API hidup pada port $Port (PID $($baru.OwningProcess))" }
else { Write-Host "API TIDAK hidup setelah 10 detik. Periksa $out dan $err"; exit 1 }
