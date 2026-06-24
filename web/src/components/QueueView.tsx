"use client";

import { X, Play, Music, GripVertical } from "lucide-react";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime } from "@/lib/format";

/** Slide-over queue: now playing + upcoming tracks, click to jump, ✕ to remove. */
export function QueueView({ onClose }: { onClose: () => void }) {
  const p = usePlayer();
  const upcoming = p.queue
    .map((t, i) => ({ t, i }))
    .filter(({ i }) => i > p.index);
  // Two layers: manually-queued songs play before the rest of the context.
  const inQueue = upcoming.filter(({ i }) => p.isUserQueued(i));
  const nextUp = upcoming.filter(({ i }) => !p.isUserQueued(i));

  const row = ({ t, i }: { t: (typeof upcoming)[number]["t"]; i: number }) => (
    <div key={`${t.id}-${i}`} className="group flex items-center gap-3 px-4 py-2 hover:bg-[var(--panel-2)]">
      <GripVertical size={14} className="shrink-0 text-[var(--muted)]/40" />
      <div className="min-w-0 flex-1 cursor-pointer" onClick={() => p.playAt(i)} title="Play">
        <div className="truncate text-sm font-medium">{t.title}</div>
        <div className="truncate text-xs text-[var(--muted)]">{t.artist?.name}</div>
      </div>
      <button
        onClick={() => p.playAt(i)}
        className="hidden shrink-0 text-[var(--muted)] transition hover:text-white group-hover:block"
        title="Play now"
      >
        <Play size={14} />
      </button>
      <button
        onClick={() => p.removeFromQueue(i)}
        className="shrink-0 text-[var(--muted)] transition hover:text-white"
        title="Remove"
      >
        <X size={14} />
      </button>
    </div>
  );

  return (
    <div className="absolute right-0 top-0 z-20 flex h-full w-80 flex-col border-l border-[var(--border)] bg-[var(--panel)] shadow-xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-semibold">Queue</div>
        <button
          onClick={onClose}
          className="rounded p-1 text-[var(--muted)] transition hover:text-white"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {p.current && (
          <div className="px-4 pb-1 pt-3 text-xs uppercase text-[var(--muted)]">Now playing</div>
        )}
        {p.current && (
          <div className="flex items-center gap-3 bg-[var(--panel-2)] px-4 py-2">
            <Music size={14} className="shrink-0 text-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--accent)]">
                {p.current.title}
              </div>
              <div className="truncate text-xs text-[var(--muted)]">{p.current.artist?.name}</div>
            </div>
            <span className="text-xs tabular-nums text-[var(--muted)]">
              {fmtTime(p.current.duration)}
            </span>
          </div>
        )}
        {inQueue.length > 0 && (
          <div className="px-4 pb-1 pt-4 text-xs uppercase text-[var(--muted)]">Next in queue</div>
        )}
        {inQueue.map(row)}
        {nextUp.length > 0 && (
          <div className="px-4 pb-1 pt-4 text-xs uppercase text-[var(--muted)]">Next up</div>
        )}
        {nextUp.map(row)}
        {p.queue.length === 0 && (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">Queue is empty</div>
        )}
      </div>
    </div>
  );
}
