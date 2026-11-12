"use client";

import { useRef } from "react";
import { X, Play, Music, GripVertical, Trash2, Infinity as InfinityIcon } from "lucide-react";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime } from "@/lib/format";

/** Slide-over queue: now playing + upcoming tracks, click to jump, ✕ to remove,
 *  drag the grip to reorder. "Clear queue" drops everything after the current
 *  track (autoplay picks included); "Clear" on Next in queue drops only the
 *  manually queued songs. Autoplay picks (radio after the queue runs out) sit in
 *  their own section with a quick on/off switch. */
export function QueueView({ onClose }: { onClose: () => void }) {
  const p = usePlayer();
  const dragFrom = useRef<number | null>(null);
  const upcoming = p.queue
    .map((t, i) => ({ t, i }))
    .filter(({ i }) => i > p.index);
  // Two layers: manually-queued songs play before the rest of the context.
  const inQueue = upcoming.filter(({ i }) => p.isUserQueued(i));
  const nextUp = upcoming.filter(({ i }) => !p.isUserQueued(i) && !p.isAutoplay(i));
  const autoUp = upcoming.filter(({ i }) => !p.isUserQueued(i) && p.isAutoplay(i));
  // Autoplay doesn't apply to a Chorus member (the host's device decides) or
  // while following someone's playback.
  const showAutoplay = !!p.current && !p.isChorusMember && !p.listeningAlong;

  const row = ({ t, i }: { t: (typeof upcoming)[number]["t"]; i: number }) => (
    <div
      key={`${t.id}-${i}`}
      draggable
      onDragStart={() => (dragFrom.current = i)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        if (dragFrom.current !== null && dragFrom.current !== i) p.moveInQueue(dragFrom.current, i);
        dragFrom.current = null;
      }}
      className="group flex items-center gap-3 px-4 py-2 hover:bg-[var(--panel-2)]"
    >
      <GripVertical size={14} className="shrink-0 cursor-grab text-[var(--muted)]/40" />
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
        <div className="flex items-center gap-1">
          {upcoming.length > 0 && (
            <button
              onClick={() => p.clearQueue()}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--muted)] transition hover:bg-[var(--panel-2)] hover:text-white"
              title="Remove everything after the current song"
            >
              <Trash2 size={13} /> Clear queue
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] transition hover:text-white"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
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
          <div className="flex items-center justify-between px-4 pb-1 pt-4">
            <span className="text-xs uppercase text-[var(--muted)]">Next in queue</span>
            {/* Clear only the songs added by hand; the playlist/album carries on. */}
            <button
              onClick={() => p.clearQueue({ userQueueOnly: true })}
              className="text-xs font-medium text-[var(--accent)] transition hover:brightness-125"
            >
              Clear
            </button>
          </div>
        )}
        {inQueue.map(row)}
        {nextUp.length > 0 && (
          <div className="px-4 pb-1 pt-4 text-xs uppercase text-[var(--muted)]">Next up</div>
        )}
        {nextUp.map(row)}
        {showAutoplay && (
          <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-4">
            <span className="flex min-w-0 items-center gap-1.5 text-xs uppercase text-[var(--muted)]">
              <InfinityIcon size={13} className="shrink-0" /> Autoplay
            </span>
            <button
              role="switch"
              aria-checked={p.autoplay}
              onClick={() => p.setAutoplay(!p.autoplay)}
              title={p.autoplay ? "Turn autoplay off" : "Turn autoplay on"}
              className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                p.autoplay ? "bg-[var(--accent)]" : "bg-[var(--panel-2)]"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                  p.autoplay ? "left-3.5" : "left-0.5"
                }`}
              />
            </button>
          </div>
        )}
        {showAutoplay && autoUp.length === 0 && (
          <div className="px-4 pb-2 text-xs text-[var(--muted)]">
            {p.autoplay
              ? "Similar songs keep playing when the queue ends."
              : "Playback stops when the queue ends."}
          </div>
        )}
        {showAutoplay && autoUp.map(row)}
        {p.queue.length === 0 && (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">Queue is empty</div>
        )}
      </div>
    </div>
  );
}
