"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PlaylistView } from "@/components/PlaylistView";
import { useAuth } from "@/context/AuthContext";
import type { Playlist } from "@/lib/types";

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);

  const load = useCallback(() => {
    api.get<Playlist>(`/api/playlists/${id}`).then(setPlaylist).catch(() => {});
  }, [id]);
  useEffect(load, [load]);

  // Stable across re-renders so the view's optimistic reorder/selection survive.
  const rows = useMemo(
    () => (playlist?.tracks ?? []).map((pt) => ({ track: pt.track, addedAt: pt.addedAt })),
    [playlist],
  );

  if (!playlist) return <div className="text-[var(--muted)]">Loading…</div>;

  async function removeTrack(trackId: string) {
    await api.del(`/api/playlists/${id}/tracks/${trackId}`);
    load();
  }

  const collabCount = playlist.collaborators?.length ?? 0;
  // Owner or collaborator (a public playlist viewed by anyone else is read-only).
  const canEdit =
    (playlist.owned ?? true) || !!playlist.collaborators?.some((c) => c.id === user?.id);
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
      onRemove={canEdit ? removeTrack : undefined}
      canEdit={canEdit}
      owned={playlist.owned ?? true}
      isPublic={playlist.isPublic}
      subtitle={subtitle}
      onChanged={load}
      onDeleted={() => router.push("/playlists")}
    />
  );
}
