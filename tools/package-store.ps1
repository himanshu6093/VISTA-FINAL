#Requires -Version 5.1
<#
.SYNOPSIS
  VISTA submission packager - builds an installable extension zip.
  vendor/ + vision/models/ are gitignored, so `git archive` alone ships a
  BROKEN extension. This script validates every offline dependency, stages a
  clean tree, and zips it (version-stamped). Run from repo root:
    powershell -ExecutionPolicy Bypass -File tools/package-store.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Ext = Join-Path $Root 'extension'
$OutDir = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$manifest = Get-Content (Join-Path $Ext 'manifest.json') -Raw | ConvertFrom-Json
$Ver = $manifest.version
Write-Output "VISTA $Ver - packaging..."

# 1. Offline dependency checklist (all 7 importmap targets + weights).
$Need = @(
  'src/offscreen/vendor/ort/ort.bundle.min.mjs',
  'src/offscreen/vendor/ort/ort.webgpu.bundle.min.mjs',
  'src/offscreen/vendor/ort/ort-wasm-simd-threaded.wasm',
  'src/offscreen/vendor/ort-common/index.js',
  'src/offscreen/vendor/paddle/web/index.js',
  'src/offscreen/vendor/ppu-ocv/index.canvas-web.js',
  'src/offscreen/vendor/jsqr/jsqr.mjs',
  'src/offscreen/vendor/jsqr/jsQR.js',
  'src/offscreen/vendor/transformers/transformers.web.min.js',
  'src/offscreen/vision/models/face/face_detection_yunet_2023mar.onnx',
  'src/offscreen/vision/models/paddle/PP-OCRv6_tiny_det.ort',
  'src/offscreen/vision/models/paddle/PP-OCRv6_tiny_rec.ort',
  'src/offscreen/vision/models/paddle/ppocrv6_tiny_dict.txt',
  'src/offscreen/vision/models/vista_pii/model_quantized.onnx',
  'src/offscreen/vision/models/vista_pii/tokenizer.json'
)
$Missing = $Need | Where-Object { -not (Test-Path (Join-Path $Ext $_)) }
if ($Missing.Count -gt 0) {
  Write-Output 'MISSING offline files (see extension/src/offscreen/vendor/README.md):'
  $Missing | ForEach-Object { Write-Output "  - $_" }
  exit 1
}

# 2. Stage clean tree (drop tests + READMEs to slim the zip; keep code).
$Stage = Join-Path ([IO.Path]::GetTempPath()) "vista-pkg-$Ver"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
Copy-Item $Ext $Stage -Recurse -Force
Remove-Item -Recurse -Force (Join-Path $Stage 'test') -ErrorAction SilentlyContinue
Get-ChildItem $Stage -Recurse -Filter 'README.md' | Remove-Item -Force

# 3. Zip + report.
$Zip = Join-Path $OutDir "vista-extension-$Ver.zip"
if (Test-Path $Zip) { Remove-Item -Force $Zip }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip
$MB = [math]::Round((Get-Item $Zip).Length / 1MB, 1)
$n = (Get-ChildItem $Stage -Recurse -File).Count
$Msg = 'OK: ' + $Zip + ' ' + $MB + 'MB ' + $n + ' files'
Write-Output $Msg
Write-Output 'Install: chrome://extensions -> Developer mode -> Load unpacked -> unzip, or drag zip onto chrome://extensions (unpacked folder load recommended).'
Remove-Item -Recurse -Force $Stage
