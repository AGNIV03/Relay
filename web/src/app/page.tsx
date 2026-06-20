"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AlbumCard } from "@/components/AlbumCard";
import type { Album } from "@/lib/types";

export default function HomePage() {
  const [recent, setRecent] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Album[]>("/api/library/albums?recent=1")
      .then(setRecent)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Welcome back</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">Recently added to your library</p>

      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : recent.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-8 text-center text-[var(--muted)]">
          Your library is empty. Drop audio files into your music folder and run a scan from the
          Admin page.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {recent.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </div>
      )}
    </div>
  );
}
