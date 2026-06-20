# Stream app (Flutter) — Windows · Android · Web

One Flutter codebase, three targets. Connects to your Stream server, browses the
library, streams audio with **background playback**, **playlists**, **favorites**,
**search**, and **offline downloads**.

## Project layout

```
lib/
├── main.dart                  app entry; platform-specific audio init
├── api.dart                   typed API client (login, library, stream URLs, refresh)
├── models.dart                Track / Album / Artist / Playlist / AppUser
├── app_state.dart             session/auth state (provider)
├── player.dart                just_audio wrapper: queue, playback, scrobble
├── downloads.dart             offline downloads (non-web)
├── theme.dart                 dark theme matching the web instance
├── screens/                   login, root nav, home, library, album, artist,
│                              search, favorites, playlists, now-playing
└── widgets/                   cover, track_tile, mini_player, album_grid
```

## Audio backends (handled automatically in `main.dart`)
- **Android / iOS / web** → `just_audio` + `just_audio_background` (lock-screen &
  notification controls, media-button support).
- **Windows / Linux / macOS** → `just_audio` + `just_audio_media_kit`.

## Running in development

```powershell
$env:Path = "A:\stream\tools\flutter\bin;" + $env:Path

flutter run -d chrome      # web (works with no extra installs)
flutter run -d windows     # desktop (needs Visual Studio C++ — see below)
flutter run -d <device>    # Android phone/emulator (needs Android SDK — see below)
```

On the login screen, enter your server URL (e.g. `http://192.168.1.50:4000`),
username, and password. From an Android **emulator**, the host machine is
`http://10.0.2.2:4000`.

## Building releases

### Web  (no extra tools)
```powershell
flutter build web      # output: build\web\  (serve as static files)
```

### Android APK  (self-contained — no Android Studio needed)
A portable JDK + Android SDK are set up under `..\tools` by a script:
```powershell
.\setup-android.ps1    # one time: extracts JDK, installs SDK, accepts licenses
.\build-android.ps1    # produces build\app\outputs\flutter-apk\app-release.apk
```
Copy the APK to your phone and tap to install (allow "unknown sources").

### Windows  .exe
Requires **Visual Studio 2022** with the *Desktop development with C++* workload
(free Community edition) and **Developer Mode** enabled
(Settings → System → For developers → Developer Mode = On):
```powershell
.\build-windows.ps1    # produces build\windows\x64\runner\Release\stream_app.exe
```
Distribute the whole `Release\` folder (the .exe needs the DLLs beside it).

## Notes
- The app stores the server URL + tokens in `shared_preferences` and auto-refreshes
  the access token, so you stay logged in.
- Cleartext `http://` is enabled in the Android manifest so LAN servers work without
  TLS; for remote access put the server behind HTTPS (see the root README).
