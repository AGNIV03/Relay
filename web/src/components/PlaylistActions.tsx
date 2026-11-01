"use client";

import { Play, Shuffle, ListPlus } from "lucide-react";
import { usePlayer } from "@/context/PlayerContext";
import { shuffled } from "@/lib/trackSort";
import type { Track } from "@/lib/types";

// Icon-only playlist controls, all the same round size. Toggles use fully
// inverted colours so their state is obvious at a glance: ON = solid accent with
// a dark icon, OFF = transparent with an accent outline and an accent icon.
const ROUND = "flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40";

/** Primary Play button: a solid accent circle. */
export function PlayRoundButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="Play"
      className={`${ROUND} bg-[var(--accent)] text-[var(--accent-ink)] shadow-lg hover:scale-105`}
    >
      <Play size={24} className="translate-x-[1px]" fill="currentColor" />
    </button>
  );
}

/** A list's remembered Shuffle toggle (separate from the player's global shuffle). */
export function ShuffleToggleButton({
  on,
  onToggle,
  disabled,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      title={on ? "Shuffle on" : "Shuffle off"}
      className={`${ROUND} ${
        on
          ? "bg-[var(--accent)] text-[var(--accent-ink)]"
          : "border-[1.5px] border-[var(--accent)] bg-transparent text-[var(--accent)] hover:bg-[var(--accent)]/10"
      }`}
    >
      <Shuffle size={20} />
    </button>
  );
}

/** Appends a whole list to the play queue (after anything already queued).
 *  Follows the list's Shuffle toggle: when `shuffle` is on the songs are queued
 *  in a random order. `onDone` receives the confirmation message. */
export function AddToQueueButton({
  tracks,
  shuffle = false,
  onDone,
}: {
  tracks: Track[];
  shuffle?: boolean;
  onDone?: (msg: string) => void;
}) {
  const player = usePlayer();
  return (
    <button
      onClick={() => {
        player.addAllToQueue(shuffle ? shuffled(tracks) : tracks);
        const n = tracks.length;
        onDone?.(
          `Added ${n} ${n === 1 ? "song" : "songs"} to the queue${shuffle && n > 1 ? ", shuffled" : ""}`,
        );
      }}
      disabled={tracks.length === 0}
      title="Add to queue"
      className={`${ROUND} border-[1.5px] border-[var(--border)] text-[var(--text)] hover:bg-[var(--panel-2)]`}
    >
      <ListPlus size={20} />
    </button>
  );
}
