"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  MoreHorizontal,
  ListEnd,
  ListPlus,
  Trash2,
  Plus,
  Info,
  Pencil,
  Mic2,
  Disc3,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { useAuth } from "@/context/AuthContext";
import type { Playlist, Track } from "@/lib/types";
import { TrackInfoDialog, type TrackDetails } from "./TrackInfoDialog";

const MENU_W = 192; // w-48

/** Per-track menu: queue actions (when a full `track` is given) + add-to-playlist,
 *  song info (editable for an admin or the uploader), plus Delete for an admin or
 *  the track's uploader. The menu renders in a portal
 *  with fixed positioning so it's never clipped by the table's overflow-hidden. */
export function AddToPlaylist({
  trackId,
  track,
  onDeleted,
  onEdited,
}: {
  trackId: string;
  track?: Track;
  onDeleted?: () => void;
  /** Called with the updated track after its metadata is saved (so lists can refresh). */
  onEdited?: (track: TrackDetails) => void;
}) {
  const player = usePlayer();
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [result, setResult] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // Fixed-position coords for the portal menu (viewport-relative).
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    // Flip up when there isn't room below (last rows above the player bar).
    if (window.innerHeight - r.bottom < 320) {
      setPos({ left, bottom: window.innerHeight - r.top + 4 });
    } else {
      setPos({ left, top: r.bottom + 4 });
    }
  }

  function toggle() {
    if (!open) place();
    setOpen((o) => !o);
  }

  const artistId = track?.artist?.id ?? track?.artistId;
  const albumId = track?.album?.id;
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const canDelete =
    user?.role === "ADMIN" || (!!track?.uploader && track.uploader.username === user?.username);

  // Mirrors the server rule for PATCH /tracks/:id (ADMIN or uploader); the dialog
  // re-checks against the full row and the server enforces it.
  const uploaderId = (track as TrackDetails | undefined)?.uploaderId;
  const canEdit =
    user?.role === "ADMIN" ||
    (uploaderId != null ? uploaderId === user?.id : canDelete);

  async function del() {
    if (!confirm(`Delete "${track?.title ?? "this song"}" permanently? This removes the file from the server.`))
      return;
    setDeleting(true);
    try {
      await api.del(`/api/library/tracks/${trackId}`);
      setOpen(false);
      if (onDeleted) onDeleted();
      else window.location.reload();
    } catch {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    api.get<Playlist[]>("/api/playlists").then(setPlaylists).catch(() => {});
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Fixed coords go stale on scroll/resize — just close the menu.
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  async function add(playlistId: string) {
    try {
      await api.post(`/api/playlists/${playlistId}/tracks`, { trackId });
      setResult({ id: playlistId, text: "✓ Added" });
    } catch (e) {
      const dup = e instanceof ApiError && e.status === 409;
      setResult({ id: playlistId, text: dup ? "Already in playlist" : "Couldn’t add" });
    }
    setTimeout(() => setOpen(false), 900);
  }

  // Create a new playlist and drop this track straight into it.
  async function createAndAdd() {
    const name = window.prompt("New playlist name")?.trim();
    if (!name) return;
    try {
      const pl = await api.post<Playlist>("/api/playlists", { name });
      await api.post(`/api/playlists/${pl.id}/tracks`, { trackId });
      setResult({ id: "new", text: "✓ Created & added" });
      window.dispatchEvent(new Event("playlists-changed"));
    } catch {
      setResult({ id: "new", text: "Couldn’t create" });
    }
    setTimeout(() => setOpen(false), 900);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="text-[var(--muted)] opacity-70 transition hover:text-white hover:opacity-100"
        title="More"
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
            className="fixed z-50 max-h-[60vh] w-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 text-left text-sm shadow-xl"
          >
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
            <button
              onClick={createAndAdd}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--accent)] hover:bg-[var(--panel)]"
            >
              <Plus size={14} /> {result?.id === "new" ? result.text : "New playlist…"}
            </button>
            {playlists.length === 0 && (
              <div className="px-3 py-2 text-xs text-[var(--muted)]">No other playlists yet</div>
            )}
            {playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => add(pl.id)}
                className="block w-full px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                {result?.id === pl.id ? result.text : pl.name}
              </button>
            ))}
            <div className="my-1 border-t border-[var(--border)]" />
            {artistId && (
              <button
                onClick={() => go(`/artists/${artistId}`)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                <Mic2 size={14} /> Go to artist
              </button>
            )}
            {albumId && (
              <button
                onClick={() => go(`/albums/${albumId}`)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                <Disc3 size={14} /> Go to album
              </button>
            )}
            <button
              onClick={() => {
                setOpen(false);
                setInfoOpen(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
            >
              {canEdit ? <Pencil size={14} /> : <Info size={14} />} {canEdit ? "Edit info" : "View info"}
            </button>
            {canDelete && (
              <>
                <div className="my-1 border-t border-[var(--border)]" />
                <button
                  onClick={del}
                  disabled={deleting}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-400 hover:bg-[var(--panel)] disabled:opacity-50"
                >
                  <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete song"}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {infoOpen && (
        <TrackInfoDialog
          trackId={trackId}
          track={track}
          onClose={() => setInfoOpen(false)}
          onSaved={onEdited}
        />
      )}
    </>
  );
}
