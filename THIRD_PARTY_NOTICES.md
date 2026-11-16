# Third-party notices

Relay is built on open-source software. This file covers components that are
bundled in, or forked into, this repository and the prebuilt apps.

## Bundled in the Windows app

| Component | License | Source |
|---|---|---|
| libmpv (`libmpv-2.dll`, audio-only build, includes FFmpeg) | LGPL-2.1-or-later | <https://github.com/media-kit/libmpv-win32-audio-build> (build scripts and patches), <https://github.com/mpv-player/mpv>, <https://ffmpeg.org> |
| media_kit | MIT | <https://github.com/media-kit/media-kit> |
| Flutter engine and framework | BSD-3-Clause | <https://github.com/flutter/flutter> |

libmpv is loaded as a separate shared library (`libmpv-2.dll`), so it can be
replaced with any compatible build. Its complete corresponding source is
available from the links above.

## Forked into `app/third_party/`

These are patched copies of published packages. Each keeps its original
license file in its own folder.

| Fork | Upstream | License |
|---|---|---|
| `app/third_party/audio_service` | <https://github.com/ryanheise/audio_service> | MIT |
| `app/third_party/just_audio_background` | <https://github.com/ryanheise/just_audio> | MIT |
| `app/third_party/just_audio_media_kit` | <https://github.com/Pato05/just_audio_media_kit> | Unlicense |

## Other dependencies

Everything else is pulled in by the package managers (`server/package.json`,
`web/package.json`, `app/pubspec.yaml`) under permissive licenses (MIT, BSD,
Apache-2.0, ISC, MPL-2.0). Icons are Google's Material Symbols (Apache-2.0).
The server image installs FFmpeg from its OS package repository at build time;
it is not distributed in this repository.

## External services

Relay can talk to these services. They are not part of Relay and have their own
terms; the lyrics and translation endpoints are unofficial and may stop working
at any time.

- LRCLIB (synced lyrics): <https://lrclib.net>
- Musixmatch (lyrics fallback, unofficial desktop API)
- Google Translate (lyric translations, unofficial public endpoint)
- AcoustID (audio fingerprinting, optional, needs your own API key)
- Last.fm and ListenBrainz (scrobbling, optional, per-user)
- Spotify Web API (playlist import, optional, needs your own app credentials)
