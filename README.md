# Stream — self-hosted music streaming

Your own music server: host audio files on a box you control, manage everything
from a web instance, and stream to a browser, a desktop app, and Android.

```
A:\stream
├── server/      Express + TypeScript + Prisma API (auth, library scan, streaming, transcoding)
├── web/         Next.js web instance — admin settings + browser player   (built next)
├── app/         Flutter app — Windows / Android, one codebase            (built next)
├── tools/       Local Flutter SDK (auto-downloaded; git-ignored)
├── music/       Your audio library (git-ignored; bind-mounted into the server)
├── data/        Derived data e.g. extracted cover art (git-ignored)
├── docker-compose.yml
└── .env         Secrets + config (copy from .env.example)
```

## Quick start (Docker — the recommended way)

Everything runs in containers; the only thing you install is Docker.

```bash
cp .env.example .env        # then edit: set MUSIC_DIR to your audio folder, pick passwords
docker compose up -d --build
```

- API:  http://localhost:4000
- First admin is created automatically from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`.
- Point `MUSIC_DIR` at the folder holding your audio files. It's mounted **read-only**.

### Scan your library
Log into the web instance (or call the API) and trigger a scan. The scanner reads
tags (title/artist/album/track no./genre/year), pulls embedded cover art, and skips
unchanged files on rescans.

## What the server does

| Capability        | Notes |
|-------------------|-------|
| Auth              | JWT access (30d) + refresh (365d). Roles: ADMIN, USER. |
| Library scan      | Recursive; reads tags via `music-metadata`; extracts cover art. |
| Streaming         | Direct file with HTTP **Range** support (seeking). |
| Transcoding       | On the fly via ffmpeg: `?format=mp3|opus|aac&bitrate=128`. |
| Search            | Tracks, albums, artists. |
| Playlists         | Per-user, ordered. |
| Favorites + plays | Mark favorites; scrobble play history. |
| Admin             | User management, trigger scans, library stats. |

## API cheat sheet

```
POST /api/auth/login            { username, password } -> { accessToken, refreshToken, user }
POST /api/auth/refresh          { refreshToken }
GET  /api/auth/me

GET  /api/library/artists | /artists/:id
GET  /api/library/albums  | /albums/:id | /albums?recent=1
GET  /api/library/tracks?limit=&offset=
GET  /api/search?q=

GET  /api/stream/:trackId                       direct, Range-aware
GET  /api/stream/:trackId?format=mp3&bitrate=128 transcoded
GET  /api/stream/:trackId/cover                  album art
     (stream/cover accept ?token= so <audio>/<img> tags can auth)

GET/POST/DELETE /api/playlists ...
PUT/DELETE      /api/favorites/:trackId
POST            /api/favorites/scrobble

GET/POST/DELETE /api/admin/users     (ADMIN)
POST/GET        /api/admin/scan      (ADMIN)
GET             /api/admin/stats     (ADMIN)
```

## Local development (without full Docker)

Host→container DB networking through Docker Desktop's port proxy can be flaky on
Windows, so the simplest reliable path is to run the whole stack in Docker (above).
If you do want hot-reload on the server, run Postgres in Docker and the server on
the host, pointing `DATABASE_URL` at `127.0.0.1:5432`.

```bash
docker compose up -d postgres
cd server && npm install && npm run prisma:generate
npm run prisma:migrate     # first time
npm run dev
```

## Status
- [x] **Server** — auth, scan, stream (Range), transcode, playlists, favorites, admin. Verified end-to-end.
- [x] **Web instance** — login, admin dashboard (users/scan/stats), browser player. Verified in browser.
- [x] **Flutter app** — browse, search, player, background playback, playlists, favorites, offline downloads.
      Code complete; builds for web + Android (APK). Windows .exe needs Visual Studio C++ (see `app/README.md`).

See `app/README.md` for building the apps and `server`/`web` for the backend + web instance.
