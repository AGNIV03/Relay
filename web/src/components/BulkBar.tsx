"use client";

import { useEffect, useRef, useState } from "react";
import { ListPlus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Playlist } from "@/lib/types";

/**
 * Action bar shown when one or more songs are selected on the Songs page.
 * Bulk add-to-playlist and bulk delete use the server's batch endpoints so it's
 * a single request regardless of how many songs are selected.
 */
export function BulkBar({
  ids,
  onClear,
  onChanged,
}: {
  ids: string[];
  onClear: () => void;
  onChanged: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    api.get<Playlist[]>("/api/playlists").then(setPlaylists).catch(() => {});
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  async function addTo(playlistId: string) {
    setBusy(true);
    try {
      const r = await api.post<{ added: number }>(`/api/playlists/${playlistId}/tracks/bulk`, {
        trackIds: ids,
      });
      const skipped = ids.length - r.added;
      setNote(`Added ${r.added}${skipped > 0 ? ` (${skipped} already there)` : ""}`);
      setTimeout(() => {
        setMenuOpen(false);
        setNote(null);
        onClear();
      }, 900);
    } catch {
      setNote("Couldn’t add");
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`Delete ${ids.length} song${ids.length === 1 ? "" : "s"} permanently? This removes the files from the server.`))
      return;
    setBusy(true);
    try {
      const r = await api.post<{ deleted: number; forbidden: number }>(
        "/api/library/tracks/bulk-delete",
        { ids },
      );
      onChanged();
      onClear();
      if (r.forbidden > 0) {
        alert(`Deleted ${r.deleted}. Skipped ${r.forbidden} you didn’t upload.`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5 text-sm">
      <span className="font-medium">{ids.length} selected</span>
      <div className="relative" ref={wrapRef}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          disabled={busy}
          className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 hover:bg-[var(--panel-2)] disabled:opacity-50"
        >
          <ListPlus size={15} /> Add to playlist
        </button>
        {menuOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 max-h-[50vh] w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 shadow-xl">
            {note && <div className="px-3 py-2 text-xs text-[var(--accent)]">{note}</div>}
            {!note && playlists.length === 0 && (
              <div className="px-3 py-2 text-xs text-[var(--muted)]">No playlists yet</div>
            )}
            {!note &&
              playlists.map((pl) => (
                <button
                  key={pl.id}
                  onClick={() => addTo(pl.id)}
                  disabled={busy}
                  className="block w-full px-3 py-2 text-left hover:bg-[var(--panel)] disabled:opacity-50"
                >
                  {pl.name}
                </button>
              ))}
          </div>
        )}
      </div>
      <button
        onClick={del}
        disabled={busy}
        className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-red-400 hover:bg-[var(--panel-2)] disabled:opacity-50"
      >
        <Trash2 size={15} /> Delete
      </button>
      <button
        onClick={onClear}
        className="ml-auto flex items-center gap-1 text-[var(--muted)] hover:text-white"
      >
        <X size={15} /> Clear
      </button>
    </div>
  );
}
