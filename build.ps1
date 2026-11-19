# Compatibility entry point. Packaging is shared by macOS, Windows and Linux.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    pnpm run package
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
