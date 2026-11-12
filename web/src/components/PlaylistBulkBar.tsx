"use client";

import { useEffect, useRef, useState } from "react";
import { ListEnd, ArrowRightLeft, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { playlistApi } from "@/lib/api2";
import { usePlayer } from "@/context/PlayerContext";
import type { Playlist, Track } from "@/lib/types";

/**
 * Action bar for songs selected inside a playlist: Add to queue (any list), plus
 * Move to playlist and Remove when the viewer can edit this playlist. Move =
 * bulk add on the target + bulk remove here.
 */
export function PlaylistBulkBar({
  tracks,
  playlistId,
  canEdit,
  onClear,
  onChanged,
  onToast,
}: {
  tracks: Track[]; // the selected tracks, in displayed order
  playlistId?: string;
  canEdit: boolean;
  onClear: () => void;
  onChanged?: () => void;
  onToast: (msg: string) => void;
}) {
  const player = usePlayer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ids = tracks.map((t) => t.id);
  const n = ids.length;
  const songs = `${n} ${n === 1 ? "song" : "songs"}`;
  const editable = canEdit && !!playlistId;

  useEffect(() => {
    if (!menuOpen) return;
    api
      .get<Playlist[]>("/api/playlists")
      .then((l) => setPlaylists(l.filter((p) => p.id !== playlistId)))
      .catch(() => {});
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, playlistId]);

  function addToQueue() {
    player.addAllToQueue(tracks);
    onToast(`Added ${songs} to the queue`);
    onClear();
  }

  async function moveTo(target: Playlist) {
    if (!playlistId) return;
    setBusy(true);
    try {
      await playlistApi.addMany(target.id, ids);
      await playlistApi.removeMany(playlistId, ids);
      onToast(`Moved ${songs} to ${target.name}`);
      setMenuOpen(false);
      onClear();
      onChanged?.();
      window.dispatchEvent(new Event("playlists-changed"));
    } catch (e) {
      onToast(e instanceof Error ? `Couldn't move: ${e.message}` : "Couldn't move");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!playlistId) return;
    if (!confirm(`Remove ${songs} from this playlist?`)) return;
    setBusy(true);
    try {
      const r = await playlistApi.removeMany(playlistId, ids);
      onToast(`Removed ${r?.removed ?? n} from the playlist`);
      onClear();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? `Couldn't remove: ${e.message}` : "Couldn't remove");
    } finally {
      setBusy(false);
    }
  }

  const pill =
    "flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 hover:bg-[var(--panel-2)] disabled:opacity-50";

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5 text-sm">
      <span className="font-medium">{n} selected</span>
      <button onClick={addToQueue} disabled={busy} className={pill}>
        <ListEnd size={15} /> Add to queue
      </button>
      {editable && (
        <div className="relative" ref={wrapRef}>
          <button onClick={() => setMenuOpen((o) => !o)} disabled={busy} className={pill}>
            <ArrowRightLeft size={15} /> Move to playlist…
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-[50vh] w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 shadow-xl">
              {playlists.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--muted)]">No other playlists</div>
              )}
              {playlists.map((pl) => (
                <button
                  key={pl.id}
                  onClick={() => moveTo(pl)}
                  disabled={busy}
                  className="block w-full truncate px-3 py-2 text-left hover:bg-[var(--panel)] disabled:opacity-50"
                >
                  {pl.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {editable && (
        <button onClick={remove} disabled={busy} className={`${pill} text-red-400`}>
          <Trash2 size={15} /> Remove
        </button>
      )}
      <button
        onClick={onClear}
        className="ml-auto flex items-center gap-1 text-[var(--muted)] hover:text-white"
      >
        <X size={15} /> Clear
      </button>
    </div>
  );
}
