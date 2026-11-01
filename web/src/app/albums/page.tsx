"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { pickSort, type SortState } from "@/lib/trackSort";
import { AlbumCard } from "@/components/AlbumCard";
import { SortMenu } from "@/components/SortMenu";
import type { Album } from "@/lib/types";

type AlbumOrder = "recent" | "title" | "artist" | "year";
const ALBUM_SORTS: { key: AlbumOrder; label: string }[] = [
  { key: "recent", label: "Recently added" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "year", label: "Year" },
];

/** Every album in the library (opened from Home's "Recently added" header).
 *  Newest first by default, with search and a sort menu like the Songs page. */
export default function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortState<AlbumOrder>>({ order: "recent", asc: true });

  useEffect(() => {
    api
      .get<Album[]>("/api/library/albums")
      .then(setAlbums)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const l = albums.filter(
      (a) =>
        !needle ||
        a.title.toLowerCase().includes(needle) ||
        (a.artist?.name ?? "").toLowerCase().includes(needle),
    );
    const str = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    l.sort((a, b) => {
      switch (sort.order) {
        case "recent":
          return str(b.createdAt ?? "", a.createdAt ?? ""); // newest first
        case "title":
          return str(a.title.toLowerCase(), b.title.toLowerCase());
        case "artist":
          return str((a.artist?.name ?? "").toLowerCase(), (b.artist?.name ?? "").toLowerCase());
        case "year":
          return (b.year ?? 0) - (a.year ?? 0); // newest year first
      }
    });
    return sort.asc ? l : l.reverse();
  }, [albums, q, sort]);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Albums</h1>
        {!loading && !error && (
          <p className="text-sm text-[var(--muted)]">
            {albums.length} {albums.length === 1 ? "album" : "albums"}
          </p>
        )}
      </div>

      <div className="mb-6 flex items-center gap-3">
        <div className="relative max-w-xl flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search albums or artists…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] py-2 pl-9 pr-9 outline-none focus:border-[var(--accent)]"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <SortMenu
          options={ALBUM_SORTS}
          order={sort.order}
          asc={sort.asc}
          onPick={(o) => setSort((s) => pickSort(s, o))}
          align="left"
        />
      </div>

      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : error ? (
        <div className="text-[var(--muted)]">Couldn&apos;t load albums.</div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-8 text-center text-[var(--muted)]">
          {q ? `No albums matching “${q}”.` : "No albums yet."}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {shown.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </div>
      )}
    </div>
  );
}
