"use client";

// Ready-to-mount Rewind entry points. Each renders nothing outside its window
// in the year or when that year has no listening data, and opens the full-screen
// story itself (RewindStory portals to <body>).

import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { unlockRewindAudio } from "./audio";
import { RewindStory } from "./RewindStory";
import { RewindSchedule, useRewindGate } from "./schedule";

/** Hook form for custom entry points: the year to offer (or null) + open state. */
function useRewindEntry(year: number | null) {
  const has = useRewindGate(year);
  const [open, setOpen] = useState(false);
  const openStory = () => {
    unlockRewindAudio(); // inside the click, so strict-autoplay browsers allow the music
    setOpen(true);
  };
  return { has, open, openStory, close: () => setOpen(false) };
}

/**
 * Home banner. Shown Dec 20 to Dec 31 (this year's Rewind) and Jan 1 to Jan 7
 * (last year's), only when that year has data. `now` is for testing.
 */
export function RewindHomeBanner({ className = "", now }: { className?: string; now?: Date }) {
  const [year] = useState(() => RewindSchedule.homeYear(now ?? new Date()));
  const { has, open, openStory, close } = useRewindEntry(year);
  if (year == null) return null;
  return (
    <>
      {has && (
        <button
          type="button"
          onClick={openStory}
          className={`group flex w-full items-center gap-3.5 rounded-2xl p-[18px] text-left text-white shadow-lg transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${className}`}
          style={{ background: "linear-gradient(135deg, #8e2de2, #ee0979)" }}
        >
          <Sparkles size={30} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold leading-tight">Your {year} Rewind is here</div>
            <div className="mt-0.5 text-[13px] text-white/70">Tap to relive your year in music</div>
          </div>
          <ChevronRight size={22} className="shrink-0 transition group-hover:translate-x-0.5" />
        </button>
      )}
      {open && <RewindStory year={year} onClose={close} />}
    </>
  );
}

/**
 * Profile entry. Shown Jan 8 to Dec 19 for last year's Rewind (after its Home
 * run), only when that year has data. `now` is for testing.
 */
export function RewindProfileEntry({ className = "", now }: { className?: string; now?: Date }) {
  const [year] = useState(() => RewindSchedule.profileYear(now ?? new Date()));
  const { has, open, openStory, close } = useRewindEntry(year);
  if (year == null) return null;
  return (
    <>
      {has && (
        <button
          type="button"
          onClick={openStory}
          className={`group flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-left transition hover:bg-[var(--panel-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${className}`}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "linear-gradient(135deg, #8e2de2, #ee0979)" }}
          >
            <Sparkles size={18} className="text-white" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-[var(--text)]">Your {year} Rewind</span>
            <span className="block text-sm text-[var(--muted)]">Relive your year in music</span>
          </span>
          <ChevronRight
            size={20}
            className="shrink-0 text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-white"
          />
        </button>
      )}
      {open && <RewindStory year={year} onClose={close} />}
    </>
  );
}
