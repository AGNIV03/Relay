"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { AlbumCard } from "@/components/AlbumCard";
import type { Artist } from "@/lib/types";

export default function ArtistPage() {
  const { id } = useParams<{ id: string }>();
  const [artist, setArtist] = useState<Artist | null>(null);

  useEffect(() => {
    api.get<Artist>(`/api/library/artists/${id}`).then(setArtist).catch(() => {});
  }, [id]);

  if (!artist) return <div className="text-[var(--muted)]">Loading…</div>;

  return (
    <div>
      <div className="text-xs uppercase text-[var(--muted)]">Artist</div>
      <h1 className="mb-6 text-3xl font-bold">{artist.name}</h1>

      <h2 className="mb-3 text-lg font-semibold">Albums</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {(artist.albums ?? []).map((a) => (
          <AlbumCard key={a.id} album={{ ...a, artist }} />
        ))}
      </div>
      {(artist.albums?.length ?? 0) === 0 && (
        <div className="text-[var(--muted)]">No albums</div>
      )}
    </div>
  );
}
