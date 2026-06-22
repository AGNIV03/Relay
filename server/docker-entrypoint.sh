#!/bin/sh
# Start as root only to fix volume ownership, then drop to the unprivileged
# `node` user for the actual app process (defence-in-depth).
set -e

mkdir -p /data /music/uploads /music/tmp
# /data holds derived data (cover art) — small, own it fully so node can write.
chown -R node:node /data 2>/dev/null || true
# The library bind-mount: own the top dir + the app-managed upload/temp dirs so node
# can create uploads, scrobble-delete, and assemble chunked uploads — without
# recursively rewriting ownership of the (possibly large) existing library, whose
# files only need to stay world-readable for node to stream them.
chown node:node /music 2>/dev/null || true
chown -R node:node /music/uploads /music/tmp 2>/dev/null || true

exec su-exec node:node "$@"
