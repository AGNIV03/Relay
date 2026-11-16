# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub instead: go to this repository's
**Security** tab and choose **Report a vulnerability**. Include:

- what the issue is and which part it affects (server, web app, Android app, Windows app)
- steps to reproduce it, or a proof of concept
- the version or commit you tested

You should get a reply within a week. Once a fix is ready it ships in a new
release, and the report is credited unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Self-hosters should keep their
server on the latest `main` / release and update the apps through Google Play
(Android) or the latest GitHub Release (Windows).

## Scope

In scope: this repository's server, web app and apps, including auth, streaming
tokens, the admin API, Chorus and file uploads.

Out of scope: problems that need an already-compromised server or admin account,
denial of service through sheer request volume, and issues in third-party
services Relay talks to (lyrics, translation, scrobbling, Spotify).

Deployment hardening (keeping ports on loopback, the reverse proxy, CORS and
rate limits) is described in the README under "Security posture".
