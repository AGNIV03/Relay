"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Artist } from "@/lib/types";

export default function ArtistsPage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Artist[]>("/api/library/artists")
      .then(setArtists)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Artists</h1>
      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {artists.map((a) => (
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
