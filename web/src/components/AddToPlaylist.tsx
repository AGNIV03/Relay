"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import type { Playlist } from "@/lib/types";

export function AddToPlaylist({ trackId }: { trackId: string }) {
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
        title="Add to playlist"
      >
        <Plus size={16} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 text-left text-sm shadow-xl">
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
