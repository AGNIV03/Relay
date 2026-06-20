"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AlbumCard } from "@/components/AlbumCard";
import type { Album } from "@/lib/types";

export default function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Album[]>("/api/library/albums")
      .then(setAlbums)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Albums</h1>
      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {albums.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </div>
      )}
    </div>
  );
}
