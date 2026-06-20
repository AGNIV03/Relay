# Sets up a self-contained Android build toolchain (portable JDK + Android SDK)
# under A:\stream\tools — no admin rights, no Android Studio, no GUI.
# Run once; afterwards `build-android.ps1` produces the APK.
$ErrorActionPreference = "Stop"

$tools = "A:\stream\tools"
$dl = "$tools\downloads"
$jdkDir = "$tools\jdk"
$sdkDir = "$tools\android-sdk"
$flutter = "$tools\flutter\bin\flutter.bat"

# --- 1. Extract portable JDK ---
if (-not (Test-Path $jdkDir)) {
  Write-Host "Extracting JDK..."
  Expand-Archive "$dl\jdk17.zip" -DestinationPath $jdkDir -Force
}
# The zip contains a nested jdk-17.x folder; find the one with bin\java.exe
$javaHome = (Get-ChildItem $jdkDir -Directory | Where-Object { Test-Path "$($_.FullName)\bin\java.exe" } | Select-Object -First 1).FullName
if (-not $javaHome) { $javaHome = $jdkDir }
$env:JAVA_HOME = $javaHome
Write-Host "JAVA_HOME = $javaHome"

# --- 2. Lay out Android command-line tools at sdk\cmdline-tools\latest ---
if (-not (Test-Path "$sdkDir\cmdline-tools\latest\bin")) {
  Write-Host "Extracting Android command-line tools..."
  $tmp = "$dl\cmdline-extract"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive "$dl\cmdline-tools.zip" -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path "$sdkDir\cmdline-tools\latest" | Out-Null
  Move-Item "$tmp\cmdline-tools\*" "$sdkDir\cmdline-tools\latest\" -Force
}

$env:ANDROID_SDK_ROOT = $sdkDir
$env:ANDROID_HOME = $sdkDir
$sdkmanager = "$sdkDir\cmdline-tools\latest\bin\sdkmanager.bat"

# --- 3. Accept licenses + install SDK packages ---
Write-Host "Accepting SDK licenses..."
$yes = ("y`n" * 20)
$yes | & $sdkmanager --sdk_root=$sdkDir --licenses
Write-Host "Installing platform-tools, platform android-35, build-tools 35.0.0..."
& $sdkmanager --sdk_root=$sdkDir "platform-tools" "platforms;android-35" "build-tools;35.0.0"

# --- 4. Point Flutter at this JDK + SDK ---
& $flutter config --jdk-dir="$javaHome"
& $flutter config --android-sdk "$sdkDir"

Write-Host ""
Write-Host "Android toolchain ready. Now run:  .\build-android.ps1"
