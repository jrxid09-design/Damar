# voice-setup.ps1 - Unduh & pasang mesin voice lokal Damar (Windows).
#
# Mengunduh dari sumber resmi saja:
#   - whisper.cpp v1.7.6 (binary Windows x64, ggml-org/whisper.cpp)
#   - Piper 2023.11.14-2 (binary Windows amd64, rhasspy/piper)
#   - Model ggml dari HuggingFace ggerganov/whisper.cpp
#   - Suara Piper id_ID news_tts dari HuggingFace rhasspy/piper-voices
#   - Supertonic 3 (Supertone/supertonic-3, OpenRAIL-M): TTS pria default
#     M1-M5 / wanita F1-F5, ONNX CPU; proyek diarsipkan Sep 2026, jadi
#     berkas di-pin ke revisi yang terverifikasi (lihat VOICE-ID.md).
#
# Semua berkas mendarat di data\voice\ (gitignored, per-instalasi).
# Jalankan:  powershell -ExecutionPolicy Bypass -File scripts\voice-setup.ps1
# Pilihan model bisa dipangkas: -Models tiny,base,small
param(
    [string[]]$Models = @('tiny', 'base', 'small', 'medium', 'turbo')
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
$base = Join-Path $root 'data\voice'
foreach ($d in @("$base\bin", "$base\models", "$base\voices", "$base\dl")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

function Get-Asset($url, $out) {
    if (Test-Path $out) { Write-Host "lewati (sudah ada) $out"; return }
    Write-Host "unduh $url"
    curl.exe -L --fail --retry 3 -C - -o "$out.part" $url
    if ($LASTEXITCODE -ne 0) { throw "unduhan gagal: $url" }
    Move-Item -Force "$out.part" $out
}

Get-Asset 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip' "$base\dl\whisper-bin-x64.zip"
Get-Asset 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip' "$base\dl\piper_windows_amd64.zip"

$modelFiles = @{
    tiny   = 'ggml-tiny.bin'
    base   = 'ggml-base.bin'
    small  = 'ggml-small.bin'
    medium = 'ggml-medium-q5_0.bin'
    turbo  = 'ggml-large-v3-turbo-q5_0.bin'
}
foreach ($m in $Models) {
    $f = $modelFiles[$m]
    if ($f) { Get-Asset "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$f" "$base\models\$f" }
}
Get-Asset 'https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx' "$base\voices\id_ID-news_tts-medium.onnx"
Get-Asset 'https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx.json' "$base\voices\id_ID-news_tts-medium.onnx.json"

# --- Supertonic 3 (TTS pria default Damar) ---
$st3 = "$base\supertonic3"
foreach ($d in @("$st3\onnx", "$st3\voice_styles")) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$st3base = 'https://huggingface.co/Supertone/supertonic-3/resolve/main'
Get-Asset "$st3base/onnx/duration_predictor.onnx" "$st3\onnx\duration_predictor.onnx"
Get-Asset "$st3base/onnx/text_encoder.onnx" "$st3\onnx\text_encoder.onnx"
Get-Asset "$st3base/onnx/vector_estimator.onnx" "$st3\onnx\vector_estimator.onnx"
Get-Asset "$st3base/onnx/vocoder.onnx" "$st3\onnx\vocoder.onnx"
Get-Asset "$st3base/onnx/tts.json" "$st3\onnx\tts.json"
Get-Asset "$st3base/onnx/unicode_indexer.json" "$st3\onnx\unicode_indexer.json"
Get-Asset "$st3base/config.json" "$st3\config.json"
foreach ($v in @('M1','M2','M3','M4','M5','F1','F2','F3','F4','F5')) {
    Get-Asset "$st3base/voice_styles/$v.json" "$st3\voice_styles\$v.json"
}
# Python venv + paket supertonic (butuh Python 3.12 di PATH;
# --system-site-packages agar torch/onnxruntime sistem ikut terlihat).
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pyCmd -and -not (Test-Path "$base\pyenv\Scripts\python.exe")) {
    python -m venv --system-site-packages "$base\pyenv"
}
if (Test-Path "$base\pyenv\Scripts\python.exe") {
    & "$base\pyenv\Scripts\python.exe" -m pip install --disable-pip-version-check supertonic
} else {
    Write-Host 'PERINGATAN: python tidak ditemukan di PATH; venv supertonic tidak dibuat.'
}

if (-not (Test-Path "$base\bin\whisper\Release\whisper-cli.exe")) {
    Expand-Archive -Force "$base\dl\whisper-bin-x64.zip" "$base\bin\whisper"
}
if (-not (Test-Path "$base\bin\piper\piper.exe")) {
    Expand-Archive -Force "$base\dl\piper_windows_amd64.zip" "$base\bin\piper"
}
Write-Host ''
Write-Host 'Selesai. Verifikasi:'
Get-ChildItem "$base\models", "$base\voices", "$base\supertonic3\onnx" | ForEach-Object { "  $($_.Name)  $([math]::Round($_.Length/1MB,1)) MB" }
Write-Host 'Jalankan server: node src\voice\local\server.js'
