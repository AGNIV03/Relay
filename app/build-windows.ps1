# Builds the native Windows desktop app.
# REQUIRES: Visual Studio 2022 with the "Desktop development with C++" workload
#           (free Community edition is fine) and Windows Developer Mode enabled.
# Output: build\windows\x64\runner\Release\stream_app.exe (+ DLLs in that folder)
$ErrorActionPreference = "Stop"
$flutter = "A:\stream\tools\flutter\bin\flutter.bat"
# Plugins with native Java bits (jni) need a JDK at configure time: use the portable one.
$env:JAVA_HOME = (Get-ChildItem "A:\stream\tools\jdk" -Directory | Where-Object { Test-Path "$($_.FullName)\bin\java.exe" } | Select-Object -First 1).FullName

Write-Host "Building Windows release..."
& $flutter build windows --release
$exe = "A:\stream\app\build\windows\x64\runner\Release\stream_app.exe"
if (Test-Path $exe) {
  Write-Host ""
  Write-Host "Built: $exe"
  Write-Host "Ship the whole 'Release' folder (the .exe needs the DLLs beside it)."
} else {
  Write-Host "Build did not produce an .exe. Is Visual Studio C++ installed? Run 'flutter doctor'."
}
