"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { TrackList } from "@/components/TrackList";
import type { Track } from "@/lib/types";

export default function FavoritesPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const player = usePlayer();

  useEffect(() => {
    api
      .get<Track[]>("/api/favorites")
      .then(setTracks)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">❤️ Favorites</h1>
        {tracks.length > 0 && (
          <button
            onClick={() => player.playQueue(tracks, 0)}
            className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--accent-2)]"
          >
            ▶ Play all
          </button>
        )}
      </div>
      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : (
        <TrackList tracks={tracks} />
      )}
    </div>
  );
}
