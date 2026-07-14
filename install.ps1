# ============================================================
# Tecoi AI — one-line installer (PowerShell)
# ============================================================
# This script is meant to be hosted somewhere with a public URL
# (e.g. GitHub) so end users can install Tecoi AI with ONE command:
#
#   irm https://raw.githubusercontent.com/YOUR-USERNAME/YOUR-REPO/main/install.ps1 | iex
#
# It downloads tecoi-cli.js into a new "Tecoi AI" folder on the
# person's Desktop, creates the double-click launcher, and opens
# the folder when it's done. No git, no npm, no manual file copying.
# ============================================================

$ErrorActionPreference = "Stop"

# EDIT THIS before hosting — point it at wherever you actually put
# tecoi-cli.js (e.g. a raw GitHub URL to the file itself).
$tecoiScriptUrl = "https://raw.githubusercontent.com/YOUR-USERNAME/YOUR-REPO/main/tecoi-cli.js"

$installDir = Join-Path $env:USERPROFILE "Desktop\Tecoi AI"

Write-Host ""
Write-Host "  Installing Tecoi AI..." -ForegroundColor Magenta
Write-Host ""

# Check for Node.js first, since Tecoi needs it to run.
$nodeCheck = Get-Command node -ErrorAction SilentlyContinue
if(-not $nodeCheck){
    Write-Host "  Node.js isn't installed yet." -ForegroundColor Yellow
    Write-Host "  Get it from https://nodejs.org (the LTS version), then run this installer again." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Write-Host "  Downloading tecoi-cli.js..."
Invoke-WebRequest -Uri $tecoiScriptUrl -OutFile (Join-Path $installDir "tecoi-cli.js")

$launcherContent = @"
@echo off
title Tecoi AI
color 0D
cd /d "%~dp0"
cls
echo.
echo   ============================
echo         TECOI AI
echo   ============================
echo.
node tecoi-cli.js
echo.
pause
"@
Set-Content -Path (Join-Path $installDir "Tecoi AI.bat") -Value $launcherContent

Write-Host ""
Write-Host "  Done! Tecoi AI is on your Desktop." -ForegroundColor Green
Write-Host "  Double-click 'Tecoi AI.bat' inside that folder to start it." -ForegroundColor Green
Write-Host ""

Invoke-Item $installDir
