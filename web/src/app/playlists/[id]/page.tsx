"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PlaylistView } from "@/components/PlaylistView";
import type { Playlist } from "@/lib/types";

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);

  const load = useCallback(() => {
    api.get<Playlist>(`/api/playlists/${id}`).then(setPlaylist).catch(() => {});
  }, [id]);
  useEffect(load, [load]);

  if (!playlist) return <div className="text-[var(--muted)]">Loading…</div>;

  const rows = (playlist.tracks ?? []).map((pt) => ({ track: pt.track, addedAt: pt.addedAt }));

  async function removeTrack(trackId: string) {
    await api.del(`/api/playlists/${id}/tracks/${trackId}`);
    load();
  }

  const collabCount = playlist.collaborators?.length ?? 0;
  const subtitle = !playlist.owned
    ? `Shared by ${playlist.owner?.username ?? "someone"}`
    : collabCount > 0
      ? `${collabCount} collaborator${collabCount === 1 ? "" : "s"}`
      : undefined;

  return (
    <PlaylistView
      name={playlist.name}
      rows={rows}
      playlistId={id}
      onRemove={removeTrack}
      owned={playlist.owned ?? true}
      isPublic={playlist.isPublic}
      subtitle={subtitle}
      onChanged={load}
      onDeleted={() => router.push("/playlists")}
    />
  );
}
