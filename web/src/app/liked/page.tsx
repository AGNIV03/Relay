"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PlaylistView } from "@/components/PlaylistView";
import { useLiked } from "@/context/LikedContext";
import type { Playlist } from "@/lib/types";

export default function LikedPage() {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const { version } = useLiked();

  useEffect(() => {
    api.get<Playlist>("/api/library/liked").then(setPlaylist).catch(() => {});
  }, [version]);

  if (!playlist) return <div className="text-[var(--muted)]">Loading…</div>;

  const rows = (playlist.tracks ?? []).map((pt) => ({ track: pt.track, addedAt: pt.addedAt }));

  return <PlaylistView name="Liked Songs" kind="Playlist" liked rows={rows} />;
}
