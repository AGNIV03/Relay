# Builds a release APK using the self-contained toolchain from setup-android.ps1.
# Output: build\app\outputs\flutter-apk\app-release.apk  (sideload onto any phone)
$ErrorActionPreference = "Stop"
$tools = "A:\stream\tools"
$flutter = "$tools\flutter\bin\flutter.bat"

$javaHome = (Get-ChildItem "$tools\jdk" -Directory | Where-Object { Test-Path "$($_.FullName)\bin\java.exe" } | Select-Object -First 1).FullName
$env:JAVA_HOME = $javaHome
$env:ANDROID_SDK_ROOT = "$tools\android-sdk"
$env:ANDROID_HOME = "$tools\android-sdk"

Write-Host "Building release APK..."
& $flutter build apk --release
$apk = "A:\stream\app\build\app\outputs\flutter-apk\app-release.apk"
if (Test-Path $apk) {
  $mb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
  Write-Host ""
  Write-Host "APK ready: $apk  ($mb MB)"
  Write-Host "Copy it to your phone and tap to install (enable 'install from unknown sources')."
} else {
  Write-Host "Build did not produce an APK. Check the output above."
}
