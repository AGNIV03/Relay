"use client";

import { useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  Music,
  Mic2,
  Shuffle,
  Repeat,
  Repeat1,
  ListMusic,
  Users,
} from "lucide-react";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime } from "@/lib/format";
import { LikeButton } from "./LikeButton";
import { SquigglyProgress } from "./SquigglyProgress";

export function PlayerBar({
  onToggleLyrics,
  lyricsOpen,
  onToggleQueue,
  queueOpen,
  onToggleFriends,
  friendsOpen,
}: {
  onToggleLyrics: () => void;
  lyricsOpen: boolean;
  onToggleQueue: () => void;
  queueOpen: boolean;
  onToggleFriends: () => void;
  friendsOpen: boolean;
}) {
  const p = usePlayer();
  const [imgError, setImgError] = useState(false);

  if (!p.current) {
    return (
      <div className="flex h-20 shrink-0 items-center justify-center border-t border-[var(--border)] bg-[var(--panel)] text-sm text-[var(--muted)]">
        Pick a track to start playing
      </div>
    );
  }

  const t = p.current;

  return (
    <div className="flex h-20 shrink-0 items-center gap-4 border-t border-[var(--border)] bg-[var(--panel)] px-4">
      {/* Now playing */}
      <div className="flex w-1/4 min-w-0 items-center gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-[var(--panel-2)]">
          {!imgError ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.coverFor(t)}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Music size={18} className="text-[var(--muted)]" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{t.title}</div>
          <div className="truncate text-xs text-[var(--muted)]">{t.artist?.name}</div>
          {(() => {
            const q = [
              t.format?.toUpperCase(),
              t.bitrate ? `${t.bitrate >= 2000 ? Math.round(t.bitrate / 1000) : t.bitrate} kbps` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return q ? (
              <div className="truncate text-[10px] uppercase tracking-wide text-[var(--muted)] opacity-70">
                {q}
              </div>
            ) : null;
          })()}
        </div>
        <LikeButton trackId={t.id} size={16} />
      </div>

      {/* Controls + seek */}
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-5">
          <button
            onClick={p.toggleShuffle}
            title="Shuffle"
            className={`transition hover:text-white ${
              p.shuffle ? "text-[var(--accent)]" : "text-[var(--muted)]"
            }`}
          >
            <Shuffle size={17} />
          </button>
          <button onClick={p.prev} className="text-[var(--muted)] transition hover:text-white" title="Previous">
            <SkipBack size={20} />
          </button>
          <button
            onClick={p.toggle}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] transition hover:scale-105"
            title="Play / pause"
          >
            {p.playing ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}
          </button>
          <button onClick={p.next} className="text-[var(--muted)] transition hover:text-white" title="Next">
            <SkipForward size={20} />
          </button>
          <button
            onClick={p.toggleRepeat}
            title={p.repeat === "one" ? "Repeat one" : p.repeat === "all" ? "Repeat all" : "Repeat"}
            className={`transition hover:text-white ${
              p.repeat !== "off" ? "text-[var(--accent)]" : "text-[var(--muted)]"
            }`}
          >
            {p.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
          </button>
        </div>
        <div className="flex w-full max-w-md items-center gap-2 text-xs text-[var(--muted)]">
          <span className="w-10 text-right tabular-nums">{fmtTime(p.position)}</span>
          <SquigglyProgress
            position={p.position}
            duration={p.duration}
            playing={p.playing}
            onSeek={p.seek}
          />
          <span className="w-10 tabular-nums">{fmtTime(p.duration)}</span>
        </div>
      </div>

      {/* Lyrics / queue / friends toggles + volume */}
      <div className="flex w-1/4 items-center justify-end gap-3">
        <button
          onClick={onToggleLyrics}
          title="Lyrics"
          className={`rounded-md p-1.5 transition hover:text-white ${
            lyricsOpen ? "text-[var(--accent)]" : "text-[var(--muted)]"
          }`}
        >
          <Mic2 size={18} />
        </button>
        <button
          onClick={onToggleQueue}
          title="Queue"
          className={`rounded-md p-1.5 transition hover:text-white ${
            queueOpen ? "text-[var(--accent)]" : "text-[var(--muted)]"
          }`}
        >
          <ListMusic size={18} />
        </button>
        <button
          onClick={onToggleFriends}
          title="Friend activity"
          className={`rounded-md p-1.5 transition hover:text-white ${
            friendsOpen ? "text-[var(--accent)]" : "text-[var(--muted)]"
          }`}
        >
          <Users size={18} />
        </button>
        <Volume2 size={18} className="text-[var(--muted)]" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={p.volume}
          onChange={(e) => p.setVolume(Number(e.target.value))}
          className="w-24"
        />
      </div>
    </div>
  );
}
