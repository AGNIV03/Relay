"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { TrackList } from "@/components/TrackList";
import { AlbumCard } from "@/components/AlbumCard";
import type { Album, Artist, Track } from "@/lib/types";

interface Results {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>({ tracks: [], albums: [], artists: [] });

  useEffect(() => {
    if (!q.trim()) {
      setResults({ tracks: [], albums: [], artists: [] });
      return;
    }
    const t = setTimeout(() => {
      api
        .get<Results>(`/api/search?q=${encodeURIComponent(q)}`)
        .then(setResults)
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const empty = !results.tracks.length && !results.albums.length && !results.artists.length;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Search</h1>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        placeholder="Songs, albums, artists…"
        className="mb-6 w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 outline-none focus:border-[var(--accent)]"
      />

      {q.trim() && empty && <div className="text-[var(--muted)]">No results for “{q}”.</div>}

      {results.artists.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Artists</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {results.artists.map((a) => (
              <Link
                key={a.id}
                href={`/artists/${a.id}`}
                className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 hover:bg-[var(--panel-2)]"
              >
                <div className="truncate font-medium">{a.name}</div>
                <div className="text-xs text-[var(--muted)]">{a._count?.tracks ?? 0} tracks</div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {results.albums.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Albums</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {results.albums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
        </section>
      )}

      {results.tracks.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Songs</h2>
          <TrackList tracks={results.tracks} />
        </section>
      )}
    </div>
  );
}
