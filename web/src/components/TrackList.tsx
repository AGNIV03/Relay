"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime } from "@/lib/format";
import type { Track } from "@/lib/types";
import { AddToPlaylist } from "./AddToPlaylist";

export function TrackList({
  tracks,
  showAlbum = true,
  showArtist = true,
}: {
  tracks: Track[];
  showAlbum?: boolean;
  showArtist?: boolean;
}) {
  const player = usePlayer();
  const [favs, setFavs] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .get<Track[]>("/api/favorites")
      .then((list) => setFavs(new Set(list.map((t) => t.id))))
      .catch(() => {});
  }, []);

  async function toggleFav(id: string) {
    const next = new Set(favs);
    if (next.has(id)) {
      next.delete(id);
      await api.del(`/api/favorites/${id}`).catch(() => {});
    } else {
      next.add(id);
      await api.put(`/api/favorites/${id}`).catch(() => {});
    }
    setFavs(next);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-[var(--muted)]">
          <tr className="border-b border-[var(--border)]">
            <th className="w-10 px-3 py-2">#</th>
            <th className="px-3 py-2">Title</th>
            {showAlbum && <th className="hidden px-3 py-2 md:table-cell">Album</th>}
            <th className="w-12 px-3 py-2"></th>
            <th className="w-12 px-3 py-2"></th>
            <th className="w-16 px-3 py-2 text-right">⏱</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t, i) => {
            const isCurrent = player.current?.id === t.id;
            return (
              <tr
                key={t.id}
                className={`group border-b border-[var(--border)]/50 hover:bg-[var(--panel-2)] ${
                  isCurrent ? "bg-[var(--panel-2)]" : ""
                }`}
              >
                <td
                  className="cursor-pointer px-3 py-2 text-[var(--muted)]"
                  onClick={() => player.playQueue(tracks, i)}
                >
                  <span className="group-hover:hidden">{isCurrent && player.playing ? "♪" : i + 1}</span>
                  <span className="hidden group-hover:inline">▶</span>
                </td>
                <td
                  className="cursor-pointer px-3 py-2"
                  onClick={() => player.playQueue(tracks, i)}
                >
                  <div className={`font-medium ${isCurrent ? "text-[var(--accent-2)]" : ""}`}>
                    {t.title}
                  </div>
                  {showArtist && (
                    <div className="text-xs text-[var(--muted)]">{t.artist?.name}</div>
                  )}
                </td>
                {showAlbum && (
                  <td className="hidden px-3 py-2 text-[var(--muted)] md:table-cell">
                    {t.album?.title}
                  </td>
                )}
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => toggleFav(t.id)}
                    className="opacity-60 hover:opacity-100"
                    title="Favorite"
                  >
                    {favs.has(t.id) ? "❤️" : "🤍"}
                  </button>
                </td>
                <td className="px-3 py-2 text-center">
                  <AddToPlaylist trackId={t.id} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--muted)]">
                  {fmtTime(t.duration)}
                </td>
              </tr>
            );
          })}
          {tracks.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-[var(--muted)]">
                No tracks
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
