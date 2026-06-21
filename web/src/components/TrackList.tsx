"use client";

import { Play, Music } from "lucide-react";
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

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-[var(--muted)]">
          <tr className="border-b border-[var(--border)]">
            <th className="w-10 px-3 py-2 text-center">#</th>
            <th className="px-3 py-2">Title</th>
            {showAlbum && <th className="hidden px-3 py-2 md:table-cell">Album</th>}
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
                  className="cursor-pointer px-3 py-2 text-center text-[var(--muted)]"
                  onClick={() => player.playQueue(tracks, i)}
                >
                  <span className="group-hover:hidden">
                    {isCurrent && player.playing ? (
                      <Music size={14} className="mx-auto text-[var(--accent)]" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <Play size={14} className="mx-auto hidden group-hover:block" />
                </td>
                <td className="cursor-pointer px-3 py-2" onClick={() => player.playQueue(tracks, i)}>
                  <div className={`font-medium ${isCurrent ? "text-[var(--accent)]" : ""}`}>
                    {t.title}
                  </div>
                  {showArtist && <div className="text-xs text-[var(--muted)]">{t.artist?.name}</div>}
                </td>
                {showAlbum && (
                  <td className="hidden px-3 py-2 text-[var(--muted)] md:table-cell">
                    {t.album?.title}
                  </td>
                )}
                <td className="px-3 py-2 text-center">
                  <AddToPlaylist trackId={t.id} track={t} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--muted)]">
                  {fmtTime(t.duration)}
                </td>
              </tr>
            );
          })}
          {tracks.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-8 text-center text-[var(--muted)]">
                No tracks
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
