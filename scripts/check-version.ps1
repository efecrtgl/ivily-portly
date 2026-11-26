# Verifies that package.json, src-tauri/Cargo.toml and CHANGELOG.md agree on
# the version, and (optionally) that a release tag matches it.
#   ./scripts/check-version.ps1               # consistency only
#   ./scripts/check-version.ps1 -Tag v0.1.0   # also require tag == version
param([string]$Tag = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$pkg = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$cargoLine = Select-String -Path (Join-Path $root "src-tauri/Cargo.toml") -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
$cargo = $cargoLine.Matches[0].Groups[1].Value
$conf = (Get-Content (Join-Path $root "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json).version

$errors = @()
if ($pkg -ne $cargo) { $errors += "package.json ($pkg) and Cargo.toml ($cargo) differ" }
if ($conf -ne "../package.json") { $errors += "tauri.conf.json version must be '../package.json' (found '$conf')" }

$changelog = Get-Content (Join-Path $root "CHANGELOG.md") -Raw
if ($changelog -notmatch "## \[$([regex]::Escape($pkg))\]") { $errors += "CHANGELOG.md has no section for $pkg" }

if ($Tag) {
  $tv = $Tag.TrimStart('v')
  if ($tv -ne $pkg) { $errors += "tag $Tag does not match version $pkg" }
}

if ($errors.Count) {
  $errors | ForEach-Object { Write-Error $_ -ErrorAction Continue }
  exit 1
}
Write-Host "Version $pkg is consistent."
