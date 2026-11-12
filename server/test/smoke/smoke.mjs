#!/usr/bin/env node
// Relay end-to-end smoke test against a LIVE deployment, through the public API.
// Not part of `npm test` (it needs a running server with a library).
//
// Usage (bash):
//   BASE_URL=https://relay.example.com RELAY_USERNAME=alice RELAY_PASSWORD='…' node test/smoke/smoke.mjs
// Usage (PowerShell):
//   $env:BASE_URL="https://relay.example.com"; $env:RELAY_USERNAME="alice"; $env:RELAY_PASSWORD="…"
//   node test/smoke/smoke.mjs
//
// Environment:
//   BASE_URL                 origin of the web app or API (the /api/* paths are appended)
//   RELAY_USERNAME / USERNAME   account to sign in with (RELAY_USERNAME wins: on Windows
//   RELAY_PASSWORD / PASSWORD   USERNAME is always set to the OS login name)
//   SMOKE_REFRESH_REUSE=1    also check refresh-token reuse detection: waits 31 s, then
//                            presents the already-rotated refresh token and expects 401.
//                            This revokes the refresh-token family of the session this
//                            script created (its own login only; other devices are untouched).
//   SMOKE_TIMEOUT_MS         per-request timeout (default 20000)
//
// What it does: health, login, /auth/me, media token, a Range request on a stream
// URL authenticated with ?token=<media token>, a cover with the media token, checks
// that ?token= is rejected on a non-media route (401), search (has a playlists
// key), radio, a throwaway playlist (create, add 2 tracks, reorder, bulk remove,
// delete), privacy + scrobbling status, admin dashboard + invites (create + revoke)
// when the user is an admin (otherwise checks the admin API answers 403), and
// refresh-token rotation. It never calls logout-all or changes settings.
//
// Everything it creates (playlist, invite) is removed in a `finally`, even when a
// step fails or the run is interrupted with Ctrl+C. Prints a PASS/FAIL table and
// exits 1 if any step (or cleanup) failed.

const BASE = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const USER = process.env.RELAY_USERNAME || process.env.USERNAME || "";
const PASS = process.env.RELAY_PASSWORD || process.env.PASSWORD || "";
const CHECK_REUSE = process.env.SMOKE_REFRESH_REUSE === "1";
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS) || 20_000;

if (!BASE || !USER || !PASS) {
  console.error("Set BASE_URL, RELAY_USERNAME (or USERNAME) and RELAY_PASSWORD (or PASSWORD).");
  process.exit(2);
}

// ---- tiny harness ------------------------------------------------------------

const results = []; // { name, status: PASS|FAIL|SKIP, ms, detail }
const cleanups = []; // { name, fn } run LIFO in finally

class Skip extends Error {}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", ms: Date.now() - t0, detail: detail ?? "" });
    return true;
  } catch (e) {
    const skip = e instanceof Skip;
    results.push({ name, status: skip ? "SKIP" : "FAIL", ms: Date.now() - t0, detail: e.message });
    return false;
  }
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

let access = "";

/** fetch against BASE. `auth`: true → Bearer access token, string → that Bearer, false → none. */
async function api(method, path, { body, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  const bearer = auth === true ? access : auth || "";
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: "manual",
  });
  const type = res.headers.get("content-type") ?? "";
  let data = null;
  if (type.includes("application/json")) data = await res.json().catch(() => null);
  else data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
}

function expectStatus(r, want, what) {
  const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
  const err = r.data && !Buffer.isBuffer(r.data) && r.data.error ? ` (${r.data.error})` : "";
  check(ok, `${what}: expected HTTP ${want}, got ${r.status}${err}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- run ---------------------------------------------------------------------

let cleaningUp = false;
async function runCleanups() {
  if (cleaningUp) return;
  cleaningUp = true;
  while (cleanups.length) {
    const c = cleanups.pop();
    await step(`cleanup: ${c.name}`, c.fn);
  }
}

process.on("SIGINT", async () => {
  console.error("\nInterrupted: cleaning up…");
  await runCleanups();
  printTable();
  process.exit(130);
});

async function main() {
  let refresh = "";
  let user = null;
  let media = "";
  let tracks = [];

  await step("health", async () => {
    const r = await api("GET", "/api/health", { auth: false });
    expectStatus(r, 200, "GET /api/health");
    check(r.data?.ok === true, "health body is not { ok: true }");
  });

  const loggedIn = await step("login", async () => {
    const r = await api("POST", "/api/auth/login", { auth: false, body: { username: USER, password: PASS } });
    expectStatus(r, 200, "POST /api/auth/login");
    check(r.data.accessToken && r.data.refreshToken && r.data.user, "missing tokens/user in login response");
    access = r.data.accessToken;
    refresh = r.data.refreshToken;
    user = r.data.user;
    return `${user.username} (${user.role})`;
  });
  if (!loggedIn) return; // nothing else can work

  await step("auth/me", async () => {
    const r = await api("GET", "/api/auth/me");
    expectStatus(r, 200, "GET /api/auth/me");
    check(r.data.username === user.username, `me.username ${r.data.username} != ${user.username}`);
  });

  await step("media-token", async () => {
    const r = await api("POST", "/api/auth/media-token");
    expectStatus(r, 200, "POST /api/auth/media-token");
    check(typeof r.data.token === "string" && r.data.token, "no media token");
    check(Date.parse(r.data.expiresAt) > Date.now(), "expiresAt not in the future");
    media = r.data.token;
  });

  await step("library tracks", async () => {
    const r = await api("GET", "/api/library/tracks?limit=25");
    expectStatus(r, 200, "GET /api/library/tracks");
    check(Array.isArray(r.data.tracks), "tracks is not an array");
    tracks = r.data.tracks;
    if (!tracks.length) throw new Skip("library is empty: stream/playlist steps will be skipped");
    return `${tracks.length} of ${r.data.total}`;
  });

  await step("stream Range request (?token=<media>)", async () => {
    if (!tracks.length || !media) throw new Skip("needs a track and a media token");
    const t = tracks[0];
    const r = await api("GET", `/api/stream/${encodeURIComponent(t.id)}?token=${encodeURIComponent(media)}`, {
      auth: false,
      headers: { Range: "bytes=0-1023" },
    });
    expectStatus(r, 206, "ranged stream");
    const cr = r.headers.get("content-range") ?? "";
    const m = /^bytes 0-(\d+)\/(\d+)$/.exec(cr);
    check(m, `bad Content-Range: "${cr}"`);
    check(r.data.length === Number(m[1]) + 1, `body ${r.data.length} bytes != Content-Range span ${Number(m[1]) + 1}`);
    check(r.data.length <= 1024, `body larger than requested: ${r.data.length}`);
    check(r.headers.get("accept-ranges") === "bytes", "Accept-Ranges is not bytes");
    return `${cr} ${r.headers.get("content-type")}`;
  });

  await step("cover (?token=<media>)", async () => {
    if (!media) throw new Skip("no media token");
    const withArt = tracks.find((t) => t.album?.coverPath);
    if (!withArt) throw new Skip("no track with album art in the first page");
    const r = await api("GET", `/api/stream/${encodeURIComponent(withArt.id)}/cover?token=${encodeURIComponent(media)}`, {
      auth: false,
    });
    expectStatus(r, 200, "cover");
    check((r.headers.get("content-type") ?? "").startsWith("image/"), `content-type ${r.headers.get("content-type")}`);
    return `${r.data.length} bytes ${r.headers.get("content-type")}`;
  });

  await step("?token= rejected on a non-media route", async () => {
    const a = await api("GET", `/api/auth/me?token=${encodeURIComponent(access)}`, { auth: false });
    expectStatus(a, 401, "GET /api/auth/me?token=<access>");
    if (media) {
      const b = await api("GET", `/api/auth/me?token=${encodeURIComponent(media)}`, { auth: false });
      expectStatus(b, 401, "GET /api/auth/me?token=<media>");
      const c = await api("GET", "/api/auth/me", { auth: media });
      expectStatus(c, 401, "media token as Bearer on a non-media route");
    }
  });

  await step("search", async () => {
    const q = (tracks[0]?.title ?? "a").slice(0, 3);
    const r = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
    expectStatus(r, 200, "GET /api/search");
    for (const k of ["tracks", "albums", "artists", "playlists"]) check(Array.isArray(r.data[k]), `search.${k} missing`);
    return `q="${q}": ${r.data.tracks.length} tracks, ${r.data.playlists.length} playlists`;
  });

  await step("radio", async () => {
    const seed = tracks[0]?.id;
    const r = await api("GET", `/api/library/radio?limit=5${seed ? `&seed=${encodeURIComponent(seed)}` : ""}`);
    expectStatus(r, 200, "GET /api/library/radio");
    check(Array.isArray(r.data), "radio did not return an array");
    check(r.data.length <= 5, `radio returned ${r.data.length} > limit 5`);
    if (seed) check(!r.data.some((t) => t.id === seed), "radio returned the seed track");
    return `${r.data.length} tracks`;
  });

  // ---- throwaway playlist ----
  const [a, b] = tracks;
  let playlistId = null;
  const plOk = await step("playlist: create", async () => {
    const r = await api("POST", "/api/playlists", { body: { name: `smoke-test ${new Date().toISOString()}` } });
    expectStatus(r, 201, "POST /api/playlists");
    playlistId = r.data.id;
    check(playlistId, "no playlist id");
    cleanups.push({
      name: "delete smoke playlist",
      fn: async () => {
        const d = await api("DELETE", `/api/playlists/${playlistId}`);
        expectStatus(d, [204, 404], "DELETE playlist");
      },
    });
    return playlistId;
  });
  const order = async () => {
    const r = await api("GET", `/api/playlists/${playlistId}`);
    expectStatus(r, 200, "GET playlist");
    return r.data.tracks.map((pt) => pt.trackId);
  };
  if (plOk) {
    const two = !!(a && b);
    await step("playlist: add 2 tracks", async () => {
      if (!two) throw new Skip("needs 2 tracks in the library");
      const r1 = await api("POST", `/api/playlists/${playlistId}/tracks`, { body: { trackId: a.id } });
      expectStatus(r1, 201, "POST /tracks");
      const r2 = await api("POST", `/api/playlists/${playlistId}/tracks/bulk`, { body: { trackIds: [b.id, a.id] } });
      expectStatus(r2, 201, "POST /tracks/bulk");
      check(r2.data.added === 1, `bulk added ${r2.data.added}, expected 1 (duplicate skipped)`);
      const ids = await order();
      check(JSON.stringify(ids) === JSON.stringify([a.id, b.id]), `order ${ids} != [a, b]`);
    });
    await step("playlist: reorder", async () => {
      if (!two) throw new Skip("needs 2 tracks");
      const r = await api("PATCH", `/api/playlists/${playlistId}/tracks/order`, { body: { trackIds: [b.id, a.id] } });
      expectStatus(r, 204, "PATCH /tracks/order");
      const ids = await order();
      check(JSON.stringify(ids) === JSON.stringify([b.id, a.id]), `order after reorder ${ids} != [b, a]`);
    });
    await step("playlist: bulk remove", async () => {
      if (!two) throw new Skip("needs 2 tracks");
      const r = await api("POST", `/api/playlists/${playlistId}/tracks/remove`, { body: { trackIds: [a.id, b.id] } });
      expectStatus(r, 200, "POST /tracks/remove");
      check(r.data.removed === 2, `removed ${r.data.removed}, expected 2`);
      check((await order()).length === 0, "playlist not empty after bulk remove");
    });
    await step("playlist: delete", async () => {
      const r = await api("DELETE", `/api/playlists/${playlistId}`);
      expectStatus(r, 204, "DELETE /api/playlists/:id");
      const g = await api("GET", `/api/playlists/${playlistId}`);
      expectStatus(g, 404, "GET deleted playlist");
      cleanups.splice(cleanups.findIndex((c) => c.name === "delete smoke playlist"), 1);
    });
  }

  await step("privacy GET", async () => {
    const r = await api("GET", "/api/social/privacy");
    expectStatus(r, 200, "GET /api/social/privacy");
    check(typeof r.data.shareActivity === "boolean", "shareActivity missing");
    check(typeof r.data.allowListenAlong === "boolean", "allowListenAlong missing");
  });

  await step("scrobbling status GET", async () => {
    const r = await api("GET", "/api/scrobbling");
    expectStatus(r, 200, "GET /api/scrobbling");
    check(r.data.listenbrainz && r.data.lastfm, "listenbrainz/lastfm keys missing");
    return `listenbrainz ${r.data.listenbrainz.connected ? "on" : "off"}, lastfm ${r.data.lastfm.connected ? "on" : "off"}`;
  });

  // ---- admin ----
  if (user.role === "ADMIN") {
    await step("admin: dashboard", async () => {
      const r = await api("GET", "/api/admin/dashboard");
      expectStatus(r, 200, "GET /api/admin/dashboard");
      check(r.data && typeof r.data === "object", "dashboard body is not an object");
    });
    await step("admin: invites list", async () => {
      const r = await api("GET", "/api/admin/invites");
      expectStatus(r, 200, "GET /api/admin/invites");
      check(Array.isArray(r.data), "invites is not an array");
      return `${r.data.length} invites`;
    });
    let invite = null;
    const created = await step("admin: create invite", async () => {
      const r = await api("POST", "/api/admin/invites", {
        body: { role: "USER", maxUses: 1, expiresInDays: 1, note: "smoke test (auto-revoked)" },
      });
      expectStatus(r, 201, "POST /api/admin/invites");
      invite = r.data;
      check(invite?.id, "no invite id");
      // Register the revoke before validating anything else, so a malformed
      // response still gets cleaned up.
      cleanups.push({
        name: "revoke smoke invite",
        fn: async () => {
          const d = await api("DELETE", `/api/admin/invites/${invite.id}`);
          expectStatus(d, [204, 404], "DELETE invite");
        },
      });
      check(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/.test(invite.code), `bad invite code ${invite.code}`);
      const v = await api("GET", `/api/auth/invite/${encodeURIComponent(invite.code.toLowerCase())}`, { auth: false });
      expectStatus(v, 200, "GET /api/auth/invite/:code");
      check(v.data.valid === true, "new invite does not check as valid");
      return invite.code;
    });
    if (created) {
      await step("admin: revoke invite", async () => {
        const r = await api("DELETE", `/api/admin/invites/${invite.id}`);
        expectStatus(r, 204, "DELETE /api/admin/invites/:id");
        cleanups.splice(cleanups.findIndex((c) => c.name === "revoke smoke invite"), 1);
        const v = await api("GET", `/api/auth/invite/${encodeURIComponent(invite.code)}`, { auth: false });
        expectStatus(v, 200, "GET /api/auth/invite/:code");
        check(v.data.valid === false, "revoked invite still checks as valid");
      });
    }
  } else {
    await step("admin API forbidden for non-admin", async () => {
      const r = await api("GET", "/api/admin/dashboard");
      expectStatus(r, 403, "GET /api/admin/dashboard as USER");
    });
  }

  // ---- refresh rotation (last: the optional reuse check revokes this session's family) ----
  const oldRefresh = refresh;
  const rotated = await step("refresh rotation", async () => {
    const r = await api("POST", "/api/auth/refresh", { auth: false, body: { refreshToken: oldRefresh } });
    expectStatus(r, 200, "POST /api/auth/refresh");
    check(r.data.accessToken && r.data.refreshToken, "missing tokens");
    check(r.data.refreshToken !== oldRefresh, "refresh token was not rotated");
    refresh = r.data.refreshToken;
    const me = await api("GET", "/api/auth/me", { auth: r.data.accessToken });
    expectStatus(me, 200, "GET /api/auth/me with the new access token");
    access = r.data.accessToken;
  });

  await step("refresh reuse after 31 s is rejected", async () => {
    if (!CHECK_REUSE) throw new Skip("set SMOKE_REFRESH_REUSE=1 to run (waits 31 s, revokes this session's family)");
    if (!rotated) throw new Skip("rotation failed");
    await sleep(31_000);
    const r = await api("POST", "/api/auth/refresh", { auth: false, body: { refreshToken: oldRefresh } });
    expectStatus(r, 401, "reusing the rotated refresh token");
    const r2 = await api("POST", "/api/auth/refresh", { auth: false, body: { refreshToken: refresh } });
    expectStatus(r2, 401, "the newer token of the revoked family");
    return "old token 401, family revoked";
  });
}

function printTable() {
  const rows = results.map((r, i) => [String(i + 1), r.name, r.status, `${r.ms}ms`, r.detail]);
  const head = ["#", "step", "result", "time", "detail"];
  const w = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  w[4] = Math.min(w[4], 90);
  const line = (cells) => cells.map((v, c) => (c === 4 ? v.slice(0, 90) : v.padEnd(w[c]))).join("  ");
  console.log(`\nRelay smoke test: ${BASE} as ${USER}\n`);
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  await runCleanups();
}
if (crashed) results.push({ name: "harness", status: "FAIL", ms: 0, detail: String(crashed?.stack ?? crashed) });
printTable();
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
