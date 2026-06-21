"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "@/context/PlayerContext";
import { api } from "@/lib/api";

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

export function LyricsView({ onClose }: { onClose: () => void }) {
  const { current, lyrics, position, seek } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);

  const [showTrans, setShowTrans] = useState(false);
  const [trans, setTrans] = useState<string | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const [loadingTrans, setLoadingTrans] = useState(false);

  const lines = useMemo(() => (lyrics?.synced ? parseLrc(lyrics.synced) : []), [lyrics?.synced]);
  const activeIdx = useMemo(() => {
    if (!lines.length) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (position >= lines[i].t - 0.2) idx = i;
      else break;
    }
    return idx;
  }, [lines, position]);

  useEffect(() => {
    if (!showTrans) activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx, showTrans]);

  // Reset translation when the track changes.
  useEffect(() => {
    setShowTrans(false);
    setTrans(null);
    setLang(null);
  }, [current?.id]);

  async function toggleTranslate() {
    if (showTrans) {
      setShowTrans(false);
      return;
    }
    setShowTrans(true);
    if (!current || trans !== null || loadingTrans) return;
    setLoadingTrans(true);
    try {
      const r = await api.get<{ lang: string | null; translated: string | null }>(
        `/api/library/tracks/${current.id}/lyrics/translation`,
      );
      setTrans(r.translated ?? "");
      setLang(r.lang);
    } catch {
      setTrans("");
    } finally {
      setLoadingTrans(false);
    }
  }

  const hasLyrics = lines.length > 0 || !!lyrics?.plain;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--bg)]/97 backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <div className="min-w-0">
          <div className="truncate text-lg font-bold">{current?.title}</div>
          <div className="truncate text-sm text-[var(--muted)]">{current?.artist?.name}</div>
        </div>
        <div className="flex items-center gap-2">
          {hasLyrics && (
            <button
              onClick={toggleTranslate}
              className={`rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm ${
                showTrans ? "text-[var(--accent)]" : "text-[var(--muted)] hover:text-white"
              }`}
            >
              {showTrans ? "Original" : "Translate"}
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
        {showTrans ? (
          loadingTrans ? (
            <div className="flex h-full items-center justify-center text-[var(--muted)]">Translating…</div>
          ) : trans ? (
            <div className="mx-auto max-w-2xl text-center">
              {lang && (
                <div className="mb-6 text-sm text-[var(--muted)]">
                  Translated from {LANG_NAMES[lang] ?? lang}
                </div>
              )}
              <pre className="whitespace-pre-wrap text-lg leading-relaxed text-[var(--text)]">{trans}</pre>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-[var(--muted)]">
              No translation available (the lyrics may already be in English).
            </div>
          )
        ) : lines.length > 0 ? (
          <div className="mx-auto max-w-2xl space-y-4 text-center">
            {lines.map((ln, i) => (
              <p
                key={i}
                ref={i === activeIdx ? activeRef : undefined}
                onClick={() => seek(ln.t)}
                className={`cursor-pointer text-2xl font-semibold transition-all ${
                  i === activeIdx
                    ? "text-[var(--accent)]"
                    : "text-[var(--muted)]/60 hover:text-[var(--muted)]"
                }`}
              >
                {ln.text || "♪"}
              </p>
            ))}
          </div>
        ) : lyrics?.plain ? (
          <pre className="mx-auto max-w-2xl whitespace-pre-wrap text-center text-lg text-[var(--text)]">
            {lyrics.plain}
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--muted)]">
            No lyrics found for this track.
          </div>
        )}
      </div>
    </div>
  );
}
