"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime } from "@/lib/format";
import type { Playlist, Track } from "@/lib/types";

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const player = usePlayer();

  const load = useCallback(() => {
    api.get<Playlist>(`/api/playlists/${id}`).then(setPlaylist).catch(() => {});
  }, [id]);
  useEffect(load, [load]);

  if (!playlist) return <div className="text-[var(--muted)]">Loading…</div>;

  const tracks: Track[] = (playlist.tracks ?? []).map((pt) => pt.track);

  async function removeTrack(trackId: string) {
    await api.del(`/api/playlists/${id}/tracks/${trackId}`);
    load();
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-[var(--muted)]">Playlist</div>
          <h1 className="text-3xl font-bold">{playlist.name}</h1>
          <div className="text-sm text-[var(--muted)]">{tracks.length} tracks</div>
        </div>
        {tracks.length > 0 && (
          <button
            onClick={() => player.playQueue(tracks, 0)}
            className="rounded-full bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white hover:bg-[var(--accent-2)]"
          >
            ▶ Play
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <table className="w-full text-sm">
          <tbody>
            {tracks.map((t, i) => (
              <tr
                key={t.id}
                className="group border-b border-[var(--border)]/50 hover:bg-[var(--panel-2)]"
              >
                <td
                  className="w-10 cursor-pointer px-3 py-2 text-[var(--muted)]"
                  onClick={() => player.playQueue(tracks, i)}
                >
                  <span className="group-hover:hidden">{i + 1}</span>
                  <span className="hidden group-hover:inline">▶</span>
                </td>
                <td
                  className="cursor-pointer px-3 py-2"
                  onClick={() => player.playQueue(tracks, i)}
                >
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {t.artist?.name}
                    {t.album?.title ? ` · ${t.album.title}` : ""}
                  </div>
                </td>
                <td className="w-16 px-3 py-2 text-right tabular-nums text-[var(--muted)]">
                  {fmtTime(t.duration)}
                </td>
                <td className="w-12 px-3 py-2 text-center">
                  <button
                    onClick={() => removeTrack(t.id)}
                    className="text-[var(--muted)] opacity-0 hover:text-red-400 group-hover:opacity-100"
                    title="Remove"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {tracks.length === 0 && (
              <tr>
                <td className="px-3 py-8 text-center text-[var(--muted)]">
                  This playlist is empty. Add songs with the ➕ button on any track.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
