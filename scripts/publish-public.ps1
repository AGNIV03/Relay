<#
.SYNOPSIS
  Refresh the `public` branch from `main` and push it.

.DESCRIPTION
  The `public` branch is the end-user bundle: the Docker-deploy files (server/, web/,
  docker-compose.yml, .env.example, .gitignore, .dockerignore), a curated user-facing
  README.md, prebuilt app downloads (downloads/), and screenshots (docs/screenshots/).
  It deliberately OMITS the Flutter app/ source and all signing secrets.

  This script rebuilds the prebuilt downloads, syncs the deploy files from `main`,
  commits, and pushes — so `public` tracks `main` after every change.

  Run it from anywhere; it operates on the repo at the path below.

.PARAMETER SkipBuild
  Reuse the existing Flutter build output instead of rebuilding the apps
  (use when you only changed server/web and the app binaries are already current).

.EXAMPLE
  pwsh scripts/publish-public.ps1            # rebuild apps, then sync + push public
  pwsh scripts/publish-public.ps1 -SkipBuild # just resync deploy files + existing builds
#>
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$repo   = 'A:\stream'
$apk    = "$repo\app\build\app\outputs\flutter-apk\app-release.apk"
$winDir = "$repo\app\build\windows\x64\runner\Release"
Set-Location $repo

# 1. Build the apps (unless reusing existing output)
if (-not $SkipBuild) {
  Push-Location "$repo\app"
  flutter build apk --release
  flutter build windows --release
  Pop-Location
}
if (-not (Test-Path $apk))    { throw "APK not found at $apk — build first (omit -SkipBuild)." }
if (-not (Test-Path $winDir)) { throw "Windows build not found at $winDir — build first." }

# 2. Make sure main is current and clean
git checkout main
git pull --ff-only

# 3. Switch to public and sync the deploy files from main.
#    NOTE: README.md, downloads/, and docs/screenshots/ are public-only — we do NOT
#    overwrite the curated README from main. Edit the public README by hand when
#    features change.
git checkout public
git checkout main -- server web docker-compose.yml .env.example .gitignore .dockerignore

# 4. Refresh the prebuilt downloads
New-Item -ItemType Directory -Force "$repo\downloads" | Out-Null
Compress-Archive -Path (Join-Path $winDir '*') -DestinationPath "$repo\downloads\Relay-Windows.zip" -Force
Copy-Item $apk "$repo\downloads\Relay-Android.apk" -Force

# 5. Commit (only if something actually changed) and push
git add server web docker-compose.yml .env.example .gitignore .dockerignore downloads docs README.md
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m "Sync public branch with main + refresh app builds"
  git push origin public
  Write-Host "`npublic branch updated and pushed." -ForegroundColor Green
} else {
  Write-Host "`npublic branch already up to date — nothing to commit." -ForegroundColor Yellow
}

# 6. Back to main
git checkout main
