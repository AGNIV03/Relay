"use client";

import { useRef, useState } from "react";
import { Play, Pause, Music, Heart, Clock, X, Shuffle, RefreshCw, Upload } from "lucide-react";
import { api, coverUrl, playlistCoverUrl, uploadPlaylistCover } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime, fmtDateAdded } from "@/lib/format";
import type { Track } from "@/lib/types";
import { LikeButton } from "./LikeButton";

export interface PlaylistTrackRow {
  track: Track;
  addedAt?: string;
}

/** Spotify-style playlist detail: gradient hero + track table. */
export function PlaylistView({
  name,
  rows,
  kind = "Playlist",
  liked = false,
  playlistId,
  onRemove,
}: {
  name: string;
  rows: PlaylistTrackRow[];
  kind?: string;
  liked?: boolean; // renders the Liked Songs gradient tile + label
  playlistId?: string; // when set, the hero cover is the editable playlist collage
  onRemove?: (trackId: string) => void;
}) {
  const player = usePlayer();
  const tracks = rows.map((r) => r.track);
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
              {tracks.length} {tracks.length === 1 ? "song" : "songs"}
              {tracks.length > 0 && <> · {fmtTotal()}</>}
            </div>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-4 px-6 py-4 md:px-10">
        <button
          onClick={() => player.playQueue(tracks, 0)}
          disabled={tracks.length === 0}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow-lg transition hover:scale-105 disabled:opacity-40"
          title="Play"
        >
          <Play size={26} className="translate-x-[1px]" fill="currentColor" />
        </button>
        <button
          onClick={() => {
            if (!player.shuffle) player.toggleShuffle();
            player.playQueue(tracks, 0);
          }}
          disabled={tracks.length === 0}
          className="text-[var(--muted)] transition hover:text-white disabled:opacity-40"
          title="Shuffle play"
        >
          <Shuffle size={22} />
        </button>
      </div>

      {/* Track table */}
      <div className="px-2 pb-8 md:px-6">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-[var(--muted)]">
            <tr className="border-b border-[var(--border)]">
              <th className="w-10 px-3 py-2 text-center">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="hidden px-3 py-2 md:table-cell">Album</th>
              <th className="hidden px-3 py-2 lg:table-cell">Date added</th>
              <th className="w-10 px-3 py-2"></th>
              <th className="w-16 px-3 py-2 text-right">
                <Clock size={14} className="ml-auto" />
              </th>
              {onRemove && <th className="w-10 px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ track: t, addedAt }, i) => {
              const isCurrent = player.current?.id === t.id;
              return (
                <tr
                  key={t.id}
                  className={`group border-b border-[var(--border)]/40 hover:bg-[var(--panel-2)] ${
                    isCurrent ? "bg-[var(--panel-2)]" : ""
                  }`}
                >
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
                  <td className="px-3 py-2 text-center">
                    <LikeButton trackId={t.id} />
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
            {rows.length === 0 && (
              <tr>
                <td colSpan={onRemove ? 7 : 6} className="px-3 py-10 text-center text-[var(--muted)]">
                  {liked
                    ? "Songs you like will show up here. Tap the ♥ on any track."
                    : "This playlist is empty. Add songs with the ➕ button on any track."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
