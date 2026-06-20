"use client";

import { useState } from "react";
import { Play, Music } from "lucide-react";
import { coverUrl } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import type { Track } from "@/lib/types";

function Card({ tracks, i }: { tracks: Track[]; i: number }) {
  const t = tracks[i];
  const player = usePlayer();
  const [err, setErr] = useState(false);
  return (
    <button
      onClick={() => player.playQueue(tracks, i)}
      className="group w-40 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-left transition hover:bg-[var(--panel-2)]"
    >
      <div className="relative mb-2 aspect-square overflow-hidden rounded-lg bg-[var(--panel-2)]">
        {!err ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl(t.id)}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setErr(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music className="text-[var(--muted)]" />
          </div>
        )}
        <div className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] opacity-0 shadow-lg transition group-hover:opacity-100">
          <Play size={16} className="translate-x-[1px]" />
        </div>
      </div>
      <div className="truncate text-sm font-medium">{t.title}</div>
      <div className="truncate text-xs text-[var(--muted)]">
        {t.artist?.name}
        {t.playCount ? ` · ${t.playCount} plays` : ""}
      </div>
    </button>
  );
}

export function TrackCards({ tracks }: { tracks: Track[] }) {
  if (!tracks.length) return null;
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {tracks.map((_, i) => (
        <Card key={tracks[i].id} tracks={tracks} i={i} />
      ))}
    </div>
  );
}
