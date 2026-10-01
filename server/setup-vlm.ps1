#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot VLM setup for VISTA server: installs Ollama (Windows), pulls the
  open-weights vision model, and verifies the planner path. Run from repo root:
    powershell -ExecutionPolicy Bypass -File server/setup-vlm.ps1
  Then:  $env:VLM_ENABLED=1; uvicorn app:app --port 8000   (from server/)
#>
$ErrorActionPreference = 'Stop'
$Model = if ($env:VLM_MODEL) { $env:VLM_MODEL } else { 'qwen2.5vl:3b' }
$Host_ = if ($env:OLLAMA_HOST) { $env:OLLAMA_HOST } else { 'http://127.0.0.1:11434' }

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Output 'Ollama not found - downloading installer...'
  $Installer = Join-Path $env:TEMP 'OllamaSetup.exe'
  curl.exe -L -o $Installer 'https://ollama.com/download/OllamaSetup.exe'
  Write-Output "Run the installer now: $Installer"
  Write-Output 'Re-run this script after install completes.'
  exit 0
}
Write-Output "Ollama found. Pulling $Model (~2GB, one-time)..."
ollama pull $Model
Write-Output 'Verifying planner path (heuristic server must be running on :8000)...'
try {
  $h = curl.exe -s "$Host_/api/tags" | ConvertFrom-Json
  $prefix = $Model.split(':')[0]
  $found = @($h.models | Where-Object { $_.name -like "$prefix*" }).Count -gt 0
  if ($found) {
    Write-Output "OK: $Model available."
  } else {
    Write-Output "WARN: model not listed; check 'ollama list'."
  }
} catch {
  Write-Output 'WARN: Ollama API unreachable - is the Ollama app running?'
}
Write-Output 'Next: cd server; set VLM_ENABLED=1; uvicorn app:app --port 8000'
Write-Output 'Eval vs heuristic: python server/eval_planner.py --base-url http://127.0.0.1:8000'
