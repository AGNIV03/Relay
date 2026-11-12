import "./helpers/env.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import {
  parseM3u,
  parseText,
  normTitle,
  spotifyPlaylistId,
  entryLabel,
  matchEntries,
  MAX_IMPORT_ENTRIES,
} from "../src/services/playlistImport.js";

describe("parseM3u", () => {
  it("uses #EXTINF 'Artist - Title' and keeps the path line as the file", () => {
    const out = parseM3u(
      [
        "#EXTM3U",
        "#EXTINF:215,Daft Punk - One More Time",
        "/music/Daft Punk/01 One More Time.mp3",
        "#EXTINF:-1,Just A Title",
        "C:\\Music\\x.flac",
      ].join("\r\n"),
    );
    assert.deepEqual(out, [
      { artist: "Daft Punk", title: "One More Time", file: "/music/Daft Punk/01 One More Time.mp3" },
      { artist: null, title: "Just A Title", file: "C:\\Music\\x.flac" },
    ]);
  });

  it("falls back to the file stem, URL-decoded, minus a leading track number", () => {
    const out = parseM3u(
      [
        "file:///home/u/Music/03%20-%20Radiohead%20-%20Creep.mp3",
        "\\\\server\\share\\07. Song Name.m4a",
        "1984.mp3", // 4 digits: a title, not a track number
      ].join("\n"),
    );
    assert.deepEqual(
      out.map(({ artist, title }) => ({ artist, title })),
      [
        { artist: "Radiohead", title: "Creep" },
        { artist: null, title: "Song Name" },
        { artist: null, title: "1984" },
      ],
    );
  });

  it("an #EXTINF survives other directives but applies to one path only", () => {
    const out = parseM3u(["#EXTINF:1,A - B", "#EXTGRP:x", "/p/one.mp3", "/p/Two.mp3"].join("\n"));
    assert.deepEqual(
      out.map((e) => [e.artist, e.title]),
      [
        ["A", "B"],
        [null, "Two"],
      ],
    );
  });

  it("an #EXTINF with an empty title falls back to the file name", () => {
    const out = parseM3u("#EXTINF:120,\n/p/Artist - Song.mp3\n");
    assert.deepEqual(out[0], { artist: "Artist", title: "Song", file: "/p/Artist - Song.mp3" });
  });

  it("survives a malformed percent-escape", () => {
    const out = parseM3u("/p/100%25 bad %zz name.mp3");
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "100%25 bad %zz name");
  });

  it(`caps at ${MAX_IMPORT_ENTRIES} entries`, () => {
    const big = Array.from({ length: MAX_IMPORT_ENTRIES + 50 }, (_, i) => `/p/Song ${i}.mp3`).join("\n");
    assert.equal(parseM3u(big).length, MAX_IMPORT_ENTRIES);
  });
});

describe("parseText", () => {
  it("parses one 'Artist - Title' per line with numbering/bullets, dashes and comments", () => {
    const out = parseText(
      [
        "1. Artist - Title",
        "2) Other – Song", // en dash
        "- Bullet — Thing", // em dash, bullet
        "* Star Item",
        "• Dot - Item",
        "# a comment",
        "   ",
        "Plain Title",
        "Artist-NoSpaces", // needs whitespace around the dash
        "A - B - Live", // first separator wins
      ].join("\n"),
    );
    assert.deepEqual(out, [
      { artist: "Artist", title: "Title" },
      { artist: "Other", title: "Song" },
      { artist: "Bullet", title: "Thing" },
      { artist: null, title: "Star Item" },
      { artist: "Dot", title: "Item" },
      { artist: null, title: "Plain Title" },
      { artist: null, title: "Artist-NoSpaces" },
      { artist: "A", title: "B - Live" },
    ]);
  });

  it(`caps at ${MAX_IMPORT_ENTRIES} entries`, () => {
    const big = Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, (_, i) => `A - S${i}`).join("\n");
    assert.equal(parseText(big).length, MAX_IMPORT_ENTRIES);
  });
});

describe("spotifyPlaylistId", () => {
  it("extracts the id from URLs and URIs", () => {
    const id = "37i9dQZF1DXcBWIGoYBM5M";
    assert.equal(spotifyPlaylistId(`https://open.spotify.com/playlist/${id}`), id);
    assert.equal(spotifyPlaylistId(`https://open.spotify.com/playlist/${id}?si=abc123`), id);
    assert.equal(spotifyPlaylistId(`https://open.spotify.com/intl-de/playlist/${id}`), id);
    assert.equal(spotifyPlaylistId(`  spotify:playlist:${id} `), id);
  });

  it("returns null for non-playlist links", () => {
    assert.equal(spotifyPlaylistId("https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M"), null);
    assert.equal(spotifyPlaylistId("https://example.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), null);
    assert.equal(spotifyPlaylistId("not a url"), null);
  });
});

describe("normTitle", () => {
  const same = (a: string, b: string) => assert.equal(normTitle(a), normTitle(b), `${a} ≡ ${b}`);

  it("drops bracketed version suffixes, feat. credits and ' - 2011 Remaster' tails", () => {
    assert.equal(normTitle("Hey Jude (Remastered 2015)"), "hey jude");
    assert.equal(normTitle("Song [Live]"), "song");
    assert.equal(normTitle("Song feat. Someone Else"), "song");
    assert.equal(normTitle("Song (feat. X)"), "song");
    assert.equal(normTitle("Song ft. X"), "song");
    assert.equal(normTitle("Song - 2011 Remaster"), "song");
    assert.equal(normTitle("Song - Radio Edit"), "song");
  });

  it("keeps a dash tail that isn't a version marker", () => {
    assert.equal(normTitle("Song - Part 2"), "song part 2");
  });

  it("folds accents, case, punctuation and &", () => {
    same("Señorita", "senorita");
    same("Rock & Roll", "rock and roll");
    same("Don’t Stop", "Don't Stop"); // curly vs straight apostrophe
    same("HELLO,  World!", "hello world");
  });

  it("keeps a title that is only brackets", () => {
    assert.equal(normTitle("(Untitled)"), "untitled");
  });
});

describe("entryLabel", () => {
  it("formats with and without an artist", () => {
    assert.equal(entryLabel({ artist: "A", title: "T" }), "A - T");
    assert.equal(entryLabel({ artist: null, title: "T" }), "T");
  });
});

describe("matchEntries", () => {
  const lib = [
    { id: "t1", title: "One More Time", path: "/m/Daft Punk/01 One More Time.mp3", artist: { name: "Daft Punk" } },
    { id: "t2", title: "Creep", path: "/m/Radiohead/Creep.flac", artist: { name: "Radiohead" } },
    { id: "t3", title: "Creep", path: "/m/TLC/Creep.mp3", artist: { name: "TLC" } },
    { id: "t4", title: "Hey Jude (Remastered 2015)", path: "/m/b/hj.mp3", artist: { name: "The Beatles" } },
    { id: "t5", title: "Unique Song", path: "/m/x/u.mp3", artist: { name: "Somebody" } },
    { id: "t6", title: "Señorita", path: "/m/s/s.mp3", artist: { name: "Shawn Mendes & Camila Cabello" } },
    { id: "t7", title: "Intro", path: "/m/a/Intro.mp3", artist: null },
  ];

  before(() => {
    Object.defineProperty(prisma, "track", {
      configurable: true,
      get: () => ({ findMany: async () => lib }),
    });
  });

  it("matches by artist + normalized title, file name, swapped fields and unique titles", async () => {
    const cases: Array<[Parameters<typeof matchEntries>[0][number], string | null]> = [
      [{ artist: "Daft Punk", title: "One More Time" }, "t1"],
      [{ artist: "TLC", title: "Creep" }, "t3"], // title shared by two tracks: artist decides
      [{ artist: null, title: "Creep" }, null], // ambiguous without an artist
      [{ artist: "Beatles", title: "Hey Jude - 2015 Remaster" }, "t4"], // "The" dropped, tail dropped
      [{ artist: "Camila Cabello", title: "Senorita" }, "t6"], // one of several credited artists
      [{ artist: "Unique Song", title: "Somebody" }, "t5"], // "Title - Artist" line
      [{ artist: "Wrong Artist", title: "Unique Song" }, "t5"], // unique title fallback
      [{ artist: "Muse", title: "Creep" }, null], // wrong artist + ambiguous title
      [{ artist: null, title: "whatever", file: "C:\\Music\\Creep.flac" }, "t2"], // file name wins
      [{ artist: "Daft Punk", title: "One More Time", file: "/elsewhere/nope.mp3" }, "t1"],
      [{ artist: null, title: "intro" }, "t7"], // track with no artist
      [{ artist: null, title: "Not In Library" }, null],
    ];
    const got = await matchEntries(cases.map((c) => c[0]));
    assert.deepEqual(
      got,
      cases.map((c) => c[1]),
    );
  });
});
