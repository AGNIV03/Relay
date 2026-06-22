#!/bin/sh
# Start as root only to fix volume ownership, then drop to the unprivileged
# `node` user for the actual app process (defence-in-depth).
set -e

mkdir -p /data
# /data holds derived data (cover art) — small, own it fully so node can write.
chown -R node:node /data 2>/dev/null || true
# /music is the (possibly large) library bind-mount — own just the top dir so node
# can create uploads / delete entries without rewriting every existing file.
chown node:node /music 2>/dev/null || true

exec su-exec node:node "$@"
