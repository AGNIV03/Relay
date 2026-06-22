"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { api } from "@/lib/api";
import type { Artist } from "@/lib/types";

export default function ArtistsPage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    api
      .get<Artist[]>("/api/library/artists")
      .then(setArtists)
      .finally(() => setLoading(false));
  }, []);

  const shown = q.trim()
    ? artists.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase()))
    : artists;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Artists</h1>
      <div className="relative mb-6 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search artists…"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] py-2 pl-9 pr-3 outline-none focus:border-[var(--accent)]"
        />
      </div>
      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="text-[var(--muted)]">No artists match “{q}”.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {shown.map((a) => (
            <Link
              key={a.id}
              href={`/artists/${a.id}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 transition hover:bg-[var(--panel-2)]"
            >
              <div className="truncate font-medium">{a.name}</div>
              <div className="text-xs text-[var(--muted)]">
                {a._count?.albums ?? 0} albums · {a._count?.tracks ?? 0} tracks
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
