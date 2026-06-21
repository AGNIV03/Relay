"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, ListEnd, ListPlus } from "lucide-react";
import { api } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import type { Playlist, Track } from "@/lib/types";

/** Per-track menu: queue actions (when a full `track` is given) + add-to-playlist. */
export function AddToPlaylist({ trackId, track }: { trackId: string; track?: Track }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [added, setAdded] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.get<Playlist[]>("/api/playlists").then(setPlaylists).catch(() => {});
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function add(playlistId: string) {
    await api.post(`/api/playlists/${playlistId}/tracks`, { trackId }).catch(() => {});
    setAdded(playlistId);
    setTimeout(() => setOpen(false), 600);
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[var(--muted)] opacity-70 transition hover:text-white hover:opacity-100"
        title="More"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 text-left text-sm shadow-xl">
          {track && (
            <>
              <button
                onClick={() => {
                  player.playNext(track);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                <ListPlus size={14} /> Play next
              </button>
              <button
                onClick={() => {
                  player.addToQueue(track);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                <ListEnd size={14} /> Add to queue
              </button>
              <div className="my-1 border-t border-[var(--border)]" />
            </>
          )}
          <div className="px-3 py-1 text-xs uppercase text-[var(--muted)]">Add to playlist</div>
          {playlists.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--muted)]">No playlists yet</div>
          )}
          {playlists.map((pl) => (
            <button
              key={pl.id}
              onClick={() => add(pl.id)}
              className="block w-full px-3 py-2 text-left hover:bg-[var(--panel)]"
            >
              {added === pl.id ? "✓ Added" : pl.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
