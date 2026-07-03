"use client";

import { useRef, type ReactNode } from "react";
import Link from "next/link";
import { Play, ChevronLeft, ChevronRight } from "lucide-react";
import { coverUrl, playlistCoverUrl } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import type { PlaylistRef, RecentItem, Track } from "@/lib/types";

/** Horizontal card row with hover scroll-arrows (shared by curated + recents). */
function Scroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 400, behavior: "smooth" });
  const arrow =
    "absolute top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--panel-2)] text-[var(--text)] shadow-lg ring-1 ring-[var(--border)] transition hover:bg-[var(--panel)] group-hover/row:flex";
  return (
    <div className="group/row relative">
      <button onClick={() => scroll(-1)} className={`${arrow} left-0 -translate-x-1`} title="Scroll left">
        <ChevronLeft size={18} />
      </button>
      <div ref={ref} className="flex gap-3 overflow-x-auto pb-2">
        {children}
      </div>
      <button onClick={() => scroll(1)} className={`${arrow} right-0 translate-x-1`} title="Scroll right">
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

function PlaylistCard({ pl }: { pl: PlaylistRef }) {
  return (
    <Link
      href={`/playlists/${pl.id}`}
      className="group w-40 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 transition hover:bg-[var(--panel-2)]"
    >
      <div className="mb-2 aspect-square overflow-hidden rounded-lg bg-[var(--panel-2)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={playlistCoverUrl(pl.id)} alt="" className="h-full w-full object-cover" />
      </div>
      <div className="truncate text-sm font-medium">{pl.name}</div>
      <div className="truncate text-xs text-[var(--muted)]">by {pl.ownerName}</div>
    </Link>
  );
}

function TrackCard({ track }: { track: Track }) {
  const player = usePlayer();
  return (
    <button
      onClick={() => player.playQueue([track])}
      className="group w-40 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-left transition hover:bg-[var(--panel-2)]"
    >
      <div className="relative mb-2 aspect-square overflow-hidden rounded-lg bg-[var(--panel-2)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverUrl(track.id)} alt="" className="h-full w-full object-cover" />
        <div className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] opacity-0 shadow-lg transition group-hover:opacity-100">
          <Play size={16} className="translate-x-[1px]" />
        </div>
      </div>
      <div className="truncate text-sm font-medium">{track.title}</div>
      <div className="truncate text-xs text-[var(--muted)]">{track.artist?.name}</div>
    </button>
  );
}

/** "Curated playlists" — public playlists from any user, shown as [name] by [user]. */
export function PlaylistCards({ playlists }: { playlists: PlaylistRef[] }) {
  if (!playlists.length) return null;
  return (
    <Scroller>
      {playlists.map((pl) => (
        <PlaylistCard key={pl.id} pl={pl} />
      ))}
    </Scroller>
  );
}

/** Recently played — a mix of tracks and (played) playlists. */
export function RecentCards({ items }: { items: RecentItem[] }) {
  if (!items.length) return null;
  return (
    <Scroller>
      {items.map((it, i) =>
        it.type === "playlist" ? (
          <PlaylistCard key={`p-${it.playlist.id}`} pl={it.playlist} />
        ) : (
          <TrackCard key={`t-${it.track.id}-${i}`} track={it.track} />
        ),
      )}
    </Scroller>
  );
}
