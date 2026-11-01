"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownUp, ArrowUp, ArrowDown, Shuffle } from "lucide-react";

/** Sort dropdown shared by the Songs / Playlists / Albums pages and playlist
 *  views. The active option is highlighted with its direction arrow; picking it
 *  again flips the direction (the caller decides — see `pickSort`). An option
 *  listed in `shuffleKey` shows a shuffle icon instead and reshuffles on pick. */
export function SortMenu<O extends string>({
  options,
  order,
  asc,
  onPick,
  shuffleKey,
  align = "right",
}: {
  options: { key: O; label: string }[];
  order: O;
  asc: boolean;
  onPick: (o: O) => void;
  shuffleKey?: O;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = options.find((o) => o.key === order);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Sort"
        className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--muted)] transition hover:bg-[var(--panel-2)] hover:text-white"
      >
        <ArrowDownUp size={15} />
        <span className="hidden sm:inline">{active?.label ?? "Sort"}</span>
      </button>
      {open && (
        <div
          className={`absolute z-30 mt-1 w-48 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 text-sm shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((o) => {
            const on = o.key === order;
            return (
              <button
                key={o.key}
                onClick={() => {
                  onPick(o.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)] ${
                  on ? "text-[var(--accent)]" : ""
                }`}
              >
                <span className="flex-1">{o.label}</span>
                {on &&
                  (o.key === shuffleKey ? (
                    <Shuffle size={14} />
                  ) : asc ? (
                    <ArrowUp size={14} />
                  ) : (
                    <ArrowDown size={14} />
                  ))}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
