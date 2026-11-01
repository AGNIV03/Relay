"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlignVerticalJustifyCenter } from "lucide-react";
import { usePlayer } from "@/context/PlayerContext";

interface Line {
  t: number; // seconds
  text: string;
}

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese", fr: "French", es: "Spanish", de: "German", it: "Italian",
  ko: "Korean", zh: "Chinese", pt: "Portuguese", ru: "Russian", hi: "Hindi",
  ar: "Arabic", nl: "Dutch", sv: "Swedish", pl: "Polish", tr: "Turkish",
};

/** Parse LRC ("[mm:ss.xx] text") into timed lines. */
function parseLrc(lrc: string): Line[] {
  const out: Line[] = [];
  for (const raw of lrc.split("\n")) {
    const matches = [...raw.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (!matches.length) continue;
    const text = raw.replace(/\[(\d+):(\d+)(?:\.(\d+))?\]/g, "").trim();
    for (const m of matches) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) / 1000 : 0;
      out.push({ t: min * 60 + sec + frac, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Align translation lines (non-empty, in order) to a list of original line texts.
 *  Empty/instrumental lines get no translation. */
function alignTranslations(originals: string[], translated: string | null | undefined): (string | null)[] {
  if (!translated) return originals.map(() => null);
  const trans = translated.split("\n");
  let j = 0;
  return originals.map((o) => (o.trim() ? trans[j++] ?? null : null));
}

export function LyricsView({ onClose }: { onClose: () => void }) {
  const { current, lyrics, lyricsLoading, position, seek } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const [showTrans, setShowTrans] = useState(false);
  const [following, setFollowing] = useState(true);

  const lines = useMemo(() => (lyrics?.synced ? parseLrc(lyrics.synced) : []), [lyrics?.synced]);
  const plainLines = useMemo(
    () => (lyrics?.plain ? lyrics.plain.split("\n") : []),
    [lyrics?.plain],
  );

  // Translation aligned to whichever view we're showing.
  const syncedTrans = useMemo(
    () => alignTranslations(lines.map((l) => l.text), lyrics?.translated),
    [lines, lyrics?.translated],
  );
  const plainTrans = useMemo(
    () => alignTranslations(plainLines, lyrics?.translated),
    [plainLines, lyrics?.translated],
  );

  const activeIdx = useMemo(() => {
    if (!lines.length) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (position >= lines[i].t - 0.2) idx = i;
      else break;
    }
    return idx;
  }, [lines, position]);

  // Auto-centre the active line while following.
  useEffect(() => {
    if (following) activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx, following]);

  // A user-initiated scroll (wheel / touch / drag) pauses auto-follow.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pause = () => setFollowing(false);
    el.addEventListener("wheel", pause, { passive: true });
    el.addEventListener("touchmove", pause, { passive: true });
    return () => {
      el.removeEventListener("wheel", pause);
      el.removeEventListener("touchmove", pause);
    };
  }, []);

  // Re-follow on a new track; default translations on when one exists.
  useEffect(() => {
    setFollowing(true);
    setShowTrans(!!lyrics?.translated);
  }, [current?.id, lyrics?.translated]);

  function resync() {
    setFollowing(true);
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const hasLyrics = lines.length > 0 || !!lyrics?.plain;
  const hasTrans = !!lyrics?.translated;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--bg)]/97 backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <div className="min-w-0">
          <div className="truncate text-lg font-bold">{current?.title}</div>
          <div className="truncate text-sm text-[var(--muted)]">
            {current?.artist?.name}
            {hasTrans && lyrics?.lang && (
              <span> · translated from {LANG_NAMES[lyrics.lang] ?? lyrics.lang}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasLyrics && hasTrans && (
            <button
              onClick={() => setShowTrans((s) => !s)}
              className={`rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm ${
                showTrans ? "text-[var(--accent)]" : "text-[var(--muted)] hover:text-white"
              }`}
            >
              {showTrans ? "Hide translation" : "Translate"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-white"
          >
            Close
          </button>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-6 py-10">
        {lines.length > 0 ? (
          <div className="mx-auto max-w-2xl space-y-4 text-center">
            {lines.map((ln, i) => (
              <div key={i} ref={i === activeIdx ? activeRef : undefined}>
                <p
                  onClick={() => seek(ln.t)}
                  className={`cursor-pointer text-2xl font-semibold transition-all ${
                    i === activeIdx
                      ? "text-[var(--accent)]"
                      : "text-[var(--muted)]/60 hover:text-[var(--muted)]"
                  }`}
                >
                  {ln.text || "♪"}
                </p>
                {showTrans && syncedTrans[i] && (
                  <p
                    onClick={() => seek(ln.t)}
                    className={`cursor-pointer text-lg italic transition-all ${
                      i === activeIdx ? "text-[var(--accent)]/80" : "text-[var(--muted)]/40"
                    }`}
                  >
                    {syncedTrans[i]}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : lyrics?.plain ? (
          <div className="mx-auto max-w-2xl space-y-2 text-center">
            {plainLines.map((ln, i) => (
              <div key={i}>
                <p className="text-lg text-[var(--text)]">{ln || " "}</p>
                {showTrans && plainTrans[i] && (
                  <p className="text-base italic text-[var(--muted)]/60">{plainTrans[i]}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          // A failed fetch resolves to empty lyrics, so this never sticks on loading.
          <div className="flex h-full items-center justify-center text-[var(--muted)]">
            {lyricsLoading ? "Loading lyrics…" : current ? "No lyrics found" : "Nothing playing"}
          </div>
        )}
      </div>

      {/* Re-sync button: shown while auto-follow is paused. */}
      {!following && lines.length > 0 && (
        <button
          onClick={resync}
          title="Sync to current line"
          className="absolute bottom-6 right-6 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow-lg transition hover:scale-105"
        >
          <AlignVerticalJustifyCenter size={20} />
        </button>
      )}
    </div>
  );
}
