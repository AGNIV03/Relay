"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Music, Heart, Clock, X, RefreshCw, Upload, GripVertical } from "lucide-react";
import { api, coverUrl, playlistCoverUrl, uploadPlaylistCover } from "@/lib/api";
import { playlistApi } from "@/lib/api2";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime, fmtDateAdded } from "@/lib/format";
import {
  TRACK_ORDER_LABELS,
  loadShufflePref,
  loadTrackSort,
  pickSort,
  saveShufflePref,
  saveTrackSort,
  sortTracks,
  type SortState,
  type TrackOrder,
} from "@/lib/trackSort";
import type { Track } from "@/lib/types";
import { LikeButton } from "./LikeButton";
import { PlaylistMenu } from "./PlaylistMenu";
import { SortMenu } from "./SortMenu";
import { PlayRoundButton, ShuffleToggleButton, AddToQueueButton } from "./PlaylistActions";
import { PlaylistBulkBar } from "./PlaylistBulkBar";
import { AddToPlaylist } from "./AddToPlaylist";

const SORT_OPTIONS = (Object.keys(TRACK_ORDER_LABELS) as TrackOrder[]).map((key) => ({
  key,
  label: TRACK_ORDER_LABELS[key],
}));

export interface PlaylistTrackRow {
  track: Track;
  addedAt?: string;
}

/** Spotify-style playlist detail: gradient hero + track table. The list's
 *  Shuffle toggle and sort order are remembered per playlist (Liked Songs uses
 *  the key "liked"); Play and Add to queue use the displayed order. */
export function PlaylistView({
  name,
  rows,
  kind = "Playlist",
  liked = false,
  playlistId,
  onRemove,
  owned,
  isPublic,
  subtitle,
  onChanged,
  onDeleted,
  canEdit = false,
}: {
  name: string;
  rows: PlaylistTrackRow[];
  kind?: string;
  liked?: boolean; // renders the Liked Songs gradient tile + label
  playlistId?: string; // when set, the hero cover is the editable playlist collage
  onRemove?: (trackId: string) => void;
  owned?: boolean; // playlist ownership (gates the rename/delete/collaborators menu)
  isPublic?: boolean; // public/curated state (for the make-public toggle)
  subtitle?: string; // e.g. "Shared by Agniv" / "2 collaborators"
  onChanged?: () => void; // reload after rename/collaborator change
  onDeleted?: () => void; // navigate away after delete/leave
  canEdit?: boolean; // owner or collaborator: drag-to-reorder + bulk move/remove
}) {
  const player = usePlayer();
  const listKey = liked ? "liked" : playlistId;
  // Per-list preferences, loaded after mount (localStorage is client-only).
  const [shufflePref, setShufflePref] = useState(false);
  const [sort, setSort] = useState<SortState<TrackOrder>>({ order: "custom", asc: true });
  useEffect(() => {
    if (!listKey) return;
    setShufflePref(loadShufflePref(listKey));
    setSort(loadTrackSort(listKey));
  }, [listKey]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  // Optimistic playlist order after a drag, until the reloaded rows arrive.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  useEffect(() => setLocalOrder(null), [rows]);
  const orderedRows = useMemo(() => {
    if (!localOrder) return rows;
    const byId = new Map(rows.map((r) => [r.track.id, r]));
    const out = localOrder.map((id) => byId.get(id)).filter((r): r is PlaylistTrackRow => !!r);
    return out.length === rows.length ? out : rows;
  }, [rows, localOrder]);

  // Displayed order ("Date added" = when the song was added to this list).
  const shownRows = useMemo(() => {
    const byId = new Map(orderedRows.map((r) => [r.track.id, r]));
    const addedAt = new Map(orderedRows.map((r) => [r.track.id, r.addedAt]));
    return sortTracks(
      orderedRows.map((r) => r.track),
      sort.order,
      sort.asc,
      addedAt,
    ).map((t) => byId.get(t.id)!);
  }, [orderedRows, sort]);
  const tracks = shownRows.map((r) => r.track);

  // Multi-select (checkbox or right click), pruned when rows change.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const ids = new Set(rows.map((r) => r.track.id));
      const n = new Set([...s].filter((id) => ids.has(id)));
      return n.size === s.size ? s : n;
    });
  }, [rows]);
  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = tracks.length > 0 && tracks.every((t) => selected.has(t.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(tracks.map((t) => t.id)));

  // Drag-to-reorder: only in "Playlist order" and for an owner/collaborator.
  const canDrag = canEdit && !!playlistId && !liked && sort.order === "custom" && tracks.length > 1;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null); // insert before this displayed index

  async function commitDrag(from: number, to: number) {
    if (!playlistId) return;
    // `to` is an insertion point in the displayed list (0..length).
    const ids = tracks.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to > from ? to - 1 : to, 0, moved);
    if (ids.every((id, i) => id === tracks[i].id)) return;
    // The displayed list is the playlist order, or its reverse when descending.
    const full = sort.asc ? ids : [...ids].reverse();
    setLocalOrder(full);
    try {
      await playlistApi.reorder(playlistId, full);
      onChanged?.();
    } catch (e) {
      setLocalOrder(null);
      showToast(e instanceof Error ? `Couldn't reorder: ${e.message}` : "Couldn't reorder");
    }
  }

  function toggleShufflePref() {
    const on = !shufflePref;
    setShufflePref(on);
    if (listKey) saveShufflePref(listKey, on);
  }

  function onPickSort(o: TrackOrder) {
    const next = pickSort(sort, o);
    setSort(next);
    if (listKey) saveTrackSort(listKey, next);
  }

  const totalSec = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const [coverErr, setCoverErr] = useState(false);
  const [thumbErr, setThumbErr] = useState<Set<string>>(new Set());
  const [coverVer, setCoverVer] = useState(0);
  const [coverMenu, setCoverMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const isPlayingThis = (id: string) => player.current?.id === id && player.playing;
  const heroCover = tracks[0] ? coverUrl(tracks[0].id) : null;

  async function regenerateCover() {
    if (!playlistId) return;
    setCoverMenu(false);
    try {
      await api.post(`/api/playlists/${playlistId}/cover/regenerate`);
      setCoverErr(false);
      setCoverVer((v) => v + 1);
    } catch {
      /* no covers to collage */
    }
  }

  async function onCoverFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setCoverMenu(false);
    if (!f || !playlistId) return;
    try {
      await uploadPlaylistCover(playlistId, f);
      setCoverErr(false);
      setCoverVer((v) => v + 1);
    } catch {
      /* ignore */
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  const fmtTotal = () => {
    const m = Math.round(totalSec / 60);
    if (m < 60) return `about ${m} min`;
    return `about ${Math.floor(m / 60)} hr ${m % 60} min`;
  };

  return (
    <div className="-mx-6 -my-6 md:-mx-10">
      {/* Hero */}
      <div
        className="px-6 pb-6 pt-8 md:px-10"
        style={{
          background: liked
            ? "linear-gradient(180deg, rgba(34,211,238,0.35), rgba(34,211,238,0.08) 55%, transparent)"
            : "linear-gradient(180deg, rgba(34,211,238,0.22), transparent)",
        }}
      >
        <div className="flex items-end gap-6">
          <div className="relative h-40 w-40 shrink-0 md:h-52 md:w-52">
            <div className="group/cover h-full w-full overflow-hidden rounded-md shadow-2xl">
              {liked ? (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)]">
                  <Heart size={64} className="text-[var(--accent-ink)]" fill="currentColor" />
                </div>
              ) : playlistId && !coverErr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={playlistCoverUrl(playlistId, coverVer)}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={() => setCoverErr(true)}
                />
              ) : heroCover && !coverErr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={heroCover}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={() => setCoverErr(true)}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-[var(--panel-2)]">
                  <Music size={56} className="text-[var(--muted)]" />
                </div>
              )}
              {playlistId && (
                <button
                  onClick={() => setCoverMenu((o) => !o)}
                  className="absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-medium text-white opacity-0 transition group-hover/cover:bg-black/45 group-hover/cover:opacity-100"
                >
                  Edit cover
                </button>
              )}
            </div>
            {playlistId && coverMenu && (
              <div className="absolute left-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel-2)] text-sm shadow-xl">
                <button
                  onClick={regenerateCover}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
                >
                  <RefreshCw size={15} /> Regenerate collage
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
                >
                  <Upload size={15} /> Upload image
                </button>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onCoverFile}
            />
          </div>
          <div className="min-w-0 pb-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              {kind}
            </div>
            <h1 className="mt-1 break-words text-4xl font-extrabold leading-tight md:text-6xl">
              {name}
            </h1>
            <div className="mt-3 text-sm text-[var(--muted)]">
              {subtitle && <span className="mr-1 font-medium text-[var(--text)]">{subtitle} ·</span>}
              {tracks.length} {tracks.length === 1 ? "song" : "songs"}
              {tracks.length > 0 && <> · {fmtTotal()}</>}
            </div>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-3 px-6 py-4 md:px-10">
        {/* Play honours this list's Shuffle toggle; when shuffling, the whole list
            is randomized so the FIRST song is random too. */}
        <PlayRoundButton
          onClick={() =>
            player.playQueue(tracks, 0, { shuffle: shufflePref, anchorStart: false, playlistId })
          }
          disabled={tracks.length === 0}
        />
        {/* Remembered per list; doesn't touch the global shuffle or what's playing. */}
        <ShuffleToggleButton
          on={shufflePref}
          onToggle={toggleShufflePref}
          disabled={tracks.length === 0}
        />
        <AddToQueueButton tracks={tracks} shuffle={shufflePref} onDone={showToast} />
        {playlistId && !liked && onChanged && onDeleted && (
          <PlaylistMenu
            playlistId={playlistId}
            name={name}
            owned={owned ?? true}
            isPublic={isPublic}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        )}
        <div className="ml-auto">
          <SortMenu options={SORT_OPTIONS} order={sort.order} asc={sort.asc} onPick={onPickSort} />
        </div>
      </div>

      {/* Track table */}
      <div className="px-2 pb-8 md:px-6">
        {selected.size > 0 && (
          <PlaylistBulkBar
            tracks={tracks.filter((t) => selected.has(t.id))}
            playlistId={liked ? undefined : playlistId}
            canEdit={canEdit}
            onClear={() => setSelected(new Set())}
            onChanged={onChanged}
            onToast={showToast}
          />
        )}
        {canDrag && selected.size === 0 && (
          <p className="mb-2 px-1 text-xs italic text-[var(--muted)]">
            Drag songs to reorder. Right click to select several.
          </p>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-[var(--muted)]">
            <tr className="border-b border-[var(--border)]">
              <th className="w-8 px-2 py-2 text-center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="cursor-pointer accent-[var(--accent)]"
                  title="Select all"
                />
              </th>
              <th className="w-10 px-3 py-2 text-center">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="hidden px-3 py-2 md:table-cell">Album</th>
              <th className="hidden px-3 py-2 lg:table-cell">Date added</th>
              <th className="w-20 px-3 py-2"></th>
              <th className="w-16 px-3 py-2 text-right">
                <Clock size={14} className="ml-auto" />
              </th>
              {onRemove && <th className="w-10 px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {shownRows.map(({ track: t, addedAt }, i) => {
              const isCurrent = player.current?.id === t.id;
              return (
                <tr
                  key={t.id}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    setDragFrom(i);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", t.id);
                  }}
                  onDragOver={(e) => {
                    if (dragFrom == null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const r = e.currentTarget.getBoundingClientRect();
                    setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom != null && dropAt != null) commitDrag(dragFrom, dropAt);
                    setDragFrom(null);
                    setDropAt(null);
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDropAt(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleSel(t.id);
                  }}
                  className={`group border-b border-[var(--border)]/40 hover:bg-[var(--panel-2)] ${
                    isCurrent || selected.has(t.id) ? "bg-[var(--panel-2)]" : ""
                  } ${dragFrom === i ? "opacity-40" : ""} ${
                    dragFrom != null && dropAt === i ? "shadow-[inset_0_2px_0_var(--accent)]" : ""
                  } ${
                    dragFrom != null && dropAt === i + 1 && i === shownRows.length - 1
                      ? "shadow-[inset_0_-2px_0_var(--accent)]"
                      : ""
                  }`}
                >
                  <td className="relative px-2 py-2 text-center">
                    {canDrag && (
                      <GripVertical
                        size={14}
                        className="absolute left-0 top-1/2 -translate-y-1/2 cursor-grab text-[var(--muted)] opacity-0 transition group-hover:opacity-100"
                      />
                    )}
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSel(t.id)}
                      className="cursor-pointer accent-[var(--accent)]"
                    />
                  </td>
                  <td
                    className="cursor-pointer px-3 py-2 text-center text-[var(--muted)]"
                    onClick={() => player.playQueue(tracks, i)}
                  >
                    <span className="group-hover:hidden">
                      {isPlayingThis(t.id) ? (
                        <Music size={14} className="mx-auto text-[var(--accent)]" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    {isPlayingThis(t.id) ? (
                      <Pause size={14} className="mx-auto hidden group-hover:block" />
                    ) : (
                      <Play size={14} className="mx-auto hidden group-hover:block" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded bg-[var(--panel-2)]"
                        onClick={() => player.playQueue(tracks, i)}
                      >
                        {!thumbErr.has(t.id) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={coverUrl(t.id)}
                            alt=""
                            className="h-full w-full object-cover"
                            onError={() => setThumbErr((s) => new Set(s).add(t.id))}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Music size={16} className="text-[var(--muted)]" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div
                          className={`cursor-pointer truncate font-medium ${isCurrent ? "text-[var(--accent)]" : ""}`}
                          onClick={() => player.playQueue(tracks, i)}
                        >
                          {t.title}
                        </div>
                        <div className="truncate text-xs text-[var(--muted)]">{t.artist?.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2 text-[var(--muted)] md:table-cell">{t.album?.title}</td>
                  <td className="hidden px-3 py-2 text-[var(--muted)] lg:table-cell">
                    {fmtDateAdded(addedAt ?? t.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-3">
                      <LikeButton trackId={t.id} />
                      <AddToPlaylist
                        trackId={t.id}
                        track={t}
                        onDeleted={onChanged}
                        onEdited={() => onChanged?.()}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--muted)]">
                    {fmtTime(t.duration)}
                  </td>
                  {onRemove && (
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => onRemove(t.id)}
                        className="text-[var(--muted)] opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                        title="Remove from playlist"
                      >
                        <X size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {shownRows.length === 0 && (
              <tr>
                <td colSpan={onRemove ? 8 : 7} className="px-3 py-10 text-center text-[var(--muted)]">
                  {liked
                    ? "Songs you like will show up here. Tap the ♥ on any track."
                    : "This playlist is empty. Add songs with the ➕ button on any track."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
