# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Relay — a self-hosted music streaming service. Three codebases in one repo:

- `server/` — Express 5 + TypeScript + Prisma (Postgres) API: auth, library scan, streaming/transcoding, playlists, social, Chorus.
- `web/` — Next.js (App Router) web app: admin UI + browser player. Also acts as the same-origin `/api` reverse proxy.
- `app/` — Flutter app, one codebase for Windows + Android (and web).

`music/`, `data/`, `tools/`, `.env` are git-ignored local state. Config lives in the root `.env` (copy from `.env.example`); the server reads it via `--env-file=../.env`.

## Commands

### Server (local dev)
```bash
docker compose up -d postgres          # DB in Docker, server on host
cd server
npm install && npm run prisma:generate
npm run prisma:migrate                 # dev migrations (first time / schema change)
npm run dev                            # tsx watch, hot reload
npm run build                          # prisma generate + tsc + tsc-alias
```
There is no test suite or linter configured for server/web; `npm run build` (tsc, strict) is the correctness check.

### Web
```bash
cd web && npm install
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev
npm run build
```

### Flutter app
The Flutter SDK (plus portable JDK + Android SDK) lives in the git-ignored `tools/` directory — use it, not a global install:
```powershell
$env:Path = "A:\stream\tools\flutter\bin;" + $env:Path
cd app
flutter analyze                        # lint
flutter run -d windows                 # or -d chrome, -d <android device>
.\build-android.ps1                    # release APK (sets JAVA_HOME/ANDROID_SDK_ROOT from tools\)
.\build-windows.ps1                    # Windows release (needs VS 2022 C++ workload)
.\setup-android.ps1                    # one-time: provisions JDK + Android SDK into tools\
```
Android release signing uses `app/android/key.properties` + keystore (both git-ignored); absent, builds fall back to debug signing.

### Full stack / publishing
```bash
docker compose up -d --build           # postgres + server + web in containers
```
`pwsh scripts/publish-public.ps1` rebuilds the apps and syncs the `public` branch (the end-user bundle: deploy files + prebuilt downloads, no `app/` source or secrets). `-SkipBuild` reuses existing app builds.

## Architecture

### Request flow — the web app is the only ingress
```
Browser/apps → Cloudflare Tunnel → web container (Next.js, 127.0.0.1:3000)
                                      │ /api/* rewrite (next.config.ts)
                                   server container (Express :4000, no published port) → postgres
```
The browser only ever talks same-origin: `web/next.config.ts` rewrites `/api/*` to the server over the internal Docker network (target overridable via `API_PROXY_TARGET`). Native apps call the API directly and send no `Origin`, so CORS is default-deny plus the `CORS_ORIGINS` allowlist. Never publish container ports to `0.0.0.0` — everything binds loopback so the tunnel/WAF can't be bypassed. Security headers/CSP for pages live in `next.config.ts`; the API deliberately disables CSP/CORP in helmet so native apps and media fetches work.

### Server
- ESM (`"type": "module"`) — relative imports need the `.js` suffix. Prisma client is generated into `server/src/generated/prisma` (schema: `server/prisma/schema.prisma`, ~10 models). `prisma migrate deploy` runs automatically on container start.
- `routes/` (auth, library, stream, search, playlists, admin, social, chorus) → `services/` (scanner, transcode via ffmpeg, lyrics/musixmatch/translate, playlistCover) → `lib/` (env, jwt, prisma, chorus, presence, pollGuard).
- **Real-time sync is long-polling, not websockets.** Presence (`lib/presence.ts`) and Chorus (`lib/chorus.ts`) are in-memory and ephemeral (cleared on restart — intentional). Every state change bumps a `version`; clients poll `.../poll?since=<version>` and the server holds the request until the version advances. `lib/pollGuard.ts` caps concurrently-held long-polls per user.
- **Chorus model**: audio plays only on the host's device. Members never write playback state directly — they enqueue *commands* (intents) the host applies and re-broadcasts; only the host may call the authoritative state write. This host-only invariant is enforced server-side; keep it that way.
- Auth: JWT access + refresh. Streaming/cover endpoints also accept `?token=` so `<audio>`/`<img>` tags can authenticate.
- Streaming (`routes/stream.ts`) is Range-aware for seeking; `?format=&bitrate=` triggers on-the-fly ffmpeg transcoding, and orphaned transcodes are killed on client disconnect.

### Web
`web/src/app` pages + `web/src/components`; global state via React contexts in `web/src/context` (AuthContext, PlayerContext, LikedContext); typed API client in `web/src/lib/api.ts`. Tailwind 4. `output: "standalone"` for the Docker image; `proxyClientMaxBodySize: "2gb"` in next.config.ts exists so large uploads survive the `/api` proxy — don't remove it.

### Flutter app
- Core singletons: `api.dart` (typed client + auth refresh), `app_state.dart` (session), `player.dart` (just_audio wrapper: queue/repeat/shuffle/scrobble), `downloads.dart` (offline mode, non-web), `events.dart` (cross-screen change notifiers). UI in `screens/` + `widgets/`; `auto_browse.dart` is Android Auto.
- Audio backend is chosen per-platform in `main.dart`: Android/iOS/web → `just_audio_background`, desktop → `just_audio_media_kit`.
- `app/third_party/` holds **patched forks** of `just_audio_background` and `just_audio_media_kit`, wired in via `dependency_overrides` in pubspec.yaml (notification button set; a concatenatingInsertAll off-by-one fix). Edit the forks, don't revert to pub versions.

### API surface
The README's "API cheat sheet" section lists all endpoints; keep it updated when routes change.
