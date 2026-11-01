"use client";

// Relay Rewind: a Spotify-Wrapped-style year in review, played back as
// full-screen "stories". Web port of app/lib/screens/rewind_screen.dart.
//
// A segmented progress bar, click/tap right to advance, left to go back, hold
// to pause (story + music). Every card has its own song, played on Rewind's own
// <audio> element (never the main player, so nothing scrobbles or reaches
// friends), and its cover drifts, blurred, behind the card.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Loader2, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { coverUrl } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { ACCENT, ACCENT2, MUTED, Curves, rgba } from "./anim";
import { PreviewPlayer, unlockRewindAudio, type PreviewResult } from "./audio";
import { buildCards, revealT, UI_ATTR, type CardCtx, type CardDef, type Fx } from "./cards";
import { loadRewind } from "./schedule";
import type { RewindData } from "./types";

const AMBIENT_MS = 14000; // one ambient loop (drift, spin, rings, equalizer)
const SWITCH_MS = 650; // card content transition
const BACKDROP_MS = 900; // backdrop crossfade
const HOLD_MS = 350; // press this long to pause instead of tapping

function useReducedMotion(): boolean {
  const [rm, setRm] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setRm(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return rm;
}

function useElementSize<T extends HTMLElement>(): [MutableRefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ------------------------------------------------------------- backdrop ----

/** Card background: the gradient, plus the card's cover blurred and slowly
 *  zooming (Ken Burns) underneath a tinted overlay, plus a vignette. */
function Backdrop({
  gradient,
  coverId,
  phase,
  opacity,
  blur,
}: {
  gradient: [string, string];
  coverId: string | null;
  phase: number;
  opacity: number;
  blur: number;
}) {
  const url = useMemo(() => (coverId ? coverUrl(coverId) : null), [coverId]);
  const [failed, setFailed] = useState(false);
  const ph = phase * Math.PI * 2;
  const show = url && !failed;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ opacity }}>
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }}
      />
      {show && (
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${Math.sin(ph) * 18}px, ${Math.cos(ph) * 12}px) scale(${1.25 + 0.08 * Math.sin(ph)})`,
            willChange: "transform",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            draggable={false}
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: `blur(${blur}px)` }}
          />
        </div>
      )}
      {show && (
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(135deg, ${rgba(gradient[0], 0.78)}, ${rgba(gradient[1], 0.7)})`,
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(circle 110vmin at center, rgba(0,0,0,0), rgba(0,0,0,0.38))" }}
      />
    </div>
  );
}

/** Soft glowing blobs drifting on slow Lissajous paths. */
function Blobs({ phase, palette }: { phase: number; palette: [string, string] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // The overlay is fixed to the viewport; avoids a forced layout every frame.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!w || !h) return;
    const k = 0.5; // soft shapes: half resolution is plenty
    const pw = Math.max(1, Math.round(w * k));
    const ph = Math.max(1, Math.round(h * k));
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, w, h);
    const p = phase * Math.PI * 2;
    const blobs: [number, number, number, number, number, string, number][] = [
      [0.2, 0.25, 0.55, 1.0, 1.0, "#ffffff", 0.1],
      [0.85, 0.7, 0.6, 0.7, 1.3, palette[1], 0.35],
      [0.5, 0.95, 0.5, 1.4, 0.8, palette[0], 0.3],
      [0.9, 0.1, 0.4, 0.9, 1.7, ACCENT2, 0.1],
    ];
    for (const [x, y, r, fx, fy, col, al] of blobs) {
      const cx = w * (x + 0.12 * Math.sin(p * fx));
      const cy = h * (y + 0.08 * Math.cos(p * fy));
      const rad = w * r;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grad.addColorStop(0, rgba(col, al));
      grad.addColorStop(1, rgba(col, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, rad, 0, Math.PI * 2);
      g.fill();
    }
  });
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
}

/** Four little bars bouncing in the top bar while music plays. */
function Equalizer({ phase }: { phase: number }) {
  return (
    <div className="flex items-end justify-between" style={{ width: 22, height: 16 }} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 3.5,
            height: 4 + 12 * Math.abs(0.5 + 0.5 * Math.sin(phase * Math.PI * 2 * (9 + i * 3) + i)),
            background: ACCENT2,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}

// --------------------------------------------------- loading / no data ----

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      {...UI_ATTR}
      onClick={onClose}
      aria-label="Close Rewind"
      className="flex h-10 w-10 items-center justify-center rounded-full text-white transition hover:bg-white/10"
    >
      <X size={22} />
    </button>
  );
}

function Loading({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="absolute right-2 top-2">
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex flex-col items-center" role="status">
        <Sparkles size={40} color={ACCENT} />
        <div className="mt-4 text-base" style={{ color: "rgba(255,255,255,0.7)" }}>
          Rewinding your year…
        </div>
        <Loader2 size={26} className="mt-4 animate-spin" color={ACCENT} />
      </div>
    </div>
  );
}

function NotEnough({ year, onClose }: { year: number; onClose: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="absolute right-2 top-2">
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex max-w-md flex-col items-center p-8 text-center">
        <Sparkles size={56} color={ACCENT} />
        <div className="mt-4 text-[22px] font-bold text-white">Your {year} Rewind isn&apos;t ready yet</div>
        <div className="mt-2.5 text-sm" style={{ color: MUTED }}>
          Keep listening and come back later. We need a bit more listening history to build your year in
          music.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------- main player handoff ----

// Module-level so a React StrictMode unmount/remount (dev) doesn't toggle the
// main player twice: a remount cancels the pending resume instead.
const handoff = { pausedMain: false, resumeTimer: null as ReturnType<typeof setTimeout> | null };

/** On open: pause the main player if it's playing (and remember). On close:
 *  resume it, but only if Rewind was the one that paused it. */
function useMainPlayerHandoff(enabled: boolean) {
  const player = usePlayer();
  const latest = useRef(player);
  latest.current = player;
  useEffect(() => {
    if (!enabled) return;
    if (handoff.resumeTimer) {
      clearTimeout(handoff.resumeTimer);
      handoff.resumeTimer = null;
    } else if (!handoff.pausedMain && latest.current.playing) {
      latest.current.toggle();
      handoff.pausedMain = true;
    }
    return () => {
      // Let the preview fade out first (~300ms), like the app's endPreview().
      handoff.resumeTimer = setTimeout(() => {
        handoff.resumeTimer = null;
        if (!handoff.pausedMain) return;
        handoff.pausedMain = false;
        const p = latest.current;
        if (!p.playing && !p.chorus && !p.listeningAlong) p.toggle();
      }, 320);
    };
  }, [enabled]);
}

// ---------------------------------------------------------------- story ----

function fxStyle(fx: Fx, v: number, rm: boolean): CSSProperties {
  if (rm) return { opacity: v };
  switch (fx) {
    case "zoom":
      return { opacity: v, transform: `scale(${0.86 + 0.14 * v})` };
    case "slideUp":
      return { opacity: v, transform: `translateY(${(1 - v) * 14}%)` };
    case "swirl":
      return { opacity: v, transform: `rotate(${-0.035 * 360 * (1 - v)}deg) scale(${0.9 + 0.1 * v})` };
    case "slideSide":
      return { opacity: v, transform: `translateX(${(1 - v) * 28}%)` };
  }
}

interface Controls {
  next: () => void;
  prev: () => void;
}

function Story({
  data,
  onClose,
  controls,
}: {
  data: RewindData;
  onClose: () => void;
  controls: MutableRefObject<Controls | null>;
}) {
  const rm = useReducedMotion();
  const cards = useMemo<CardDef[]>(() => buildCards(data), [data]);
  const player = usePlayer();

  // Stay silent in a Chorus or listen-along, where hijacking playback would
  // break the session (same rule as the app's beginPreview()).
  const [audioOk] = useState(() => !player.chorus && !player.listeningAlong);
  useMainPlayerHandoff(audioOk);

  const previewRef = useRef<PreviewPlayer | null>(null);
  if (!previewRef.current) previewRef.current = new PreviewPlayer();
  const preview = previewRef.current;

  const [page, setPage] = useState(0);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [sounding, setSounding] = useState(false);
  const [, setTick] = useState(0);

  const pageRef = useRef(0);
  const elapsedRef = useRef(0); // ms into the current card
  const holdRef = useRef(false);
  const clockRef = useRef(0); // monotonic story clock (ms)
  const ambRef = useRef(0); // ambient clock (ms)
  const switchRef = useRef<{ from: number | null; at: number }>({ from: null, at: -1e9 });
  const playingIdRef = useRef<string | null>(null);

  const columnRef = useRef<HTMLDivElement | null>(null);
  const [areaRef, area] = useElementSize<HTMLDivElement>();
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 400 : window.innerWidth));
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const handleResult = useCallback((r: PreviewResult) => {
    if (r === "cancelled") return;
    setBlocked(r === "blocked");
    setSounding(r === "ok");
  }, []);

  /** Crossfade to the current card's song if it differs from what's playing. */
  const syncSong = useCallback(
    (p: number) => {
      if (!audioOk) return;
      const id = cards[p]?.trackId;
      const t = id ? data.tracks[id] : undefined;
      if (!t || t.id === playingIdRef.current) return;
      playingIdRef.current = t.id;
      preview.play(t).then(handleResult);
    },
    [audioOk, cards, data.tracks, preview, handleResult],
  );

  // Start the music; stop it when the story closes.
  useEffect(() => {
    if (!audioOk) return;
    preview.target = player.volume > 0 ? player.volume : 1;
    syncSong(pageRef.current);
    return () => {
      playingIdRef.current = null;
      void preview.stop(300);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOk, preview]);

  const go = useCallback(
    (p: number) => {
      if (p < 0 || p >= cards.length) return;
      switchRef.current = { from: pageRef.current, at: clockRef.current };
      pageRef.current = p;
      elapsedRef.current = 0;
      setPage(p);
      syncSong(p);
    },
    [cards.length, syncSong],
  );

  const next = useCallback(() => {
    const p = pageRef.current;
    if (p >= cards.length - 1) {
      elapsedRef.current = cards[p].duration; // hold on the recap instead of closing
      return;
    }
    go(p + 1);
  }, [cards, go]);

  const prev = useCallback(() => {
    if (pageRef.current === 0) {
      elapsedRef.current = 0;
      return;
    }
    go(pageRef.current - 1);
  }, [go]);

  const restart = useCallback(() => go(0), [go]);

  useEffect(() => {
    controls.current = { next, prev };
    return () => {
      controls.current = null;
    };
  }, [controls, next, prev]);

  // The story clock: one rAF loop drives the card timer and the ambient phase.
  const nextRef = useRef(next);
  nextRef.current = next;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - last)); // a background tab doesn't jump ahead
      last = now;
      clockRef.current += dt;
      ambRef.current += dt;
      const card = cards[pageRef.current];
      if (card && !holdRef.current && elapsedRef.current < card.duration) {
        elapsedRef.current = Math.min(card.duration, elapsedRef.current + dt);
        if (elapsedRef.current >= card.duration) nextRef.current();
      }
      setTick((x) => (x + 1) % 1e9);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cards]);

  // ---- input: tap zones + press-and-hold ----
  const pressRef = useRef<{ id: number; timer: ReturnType<typeof setTimeout> | null; held: boolean } | null>(null);

  const setHold = useCallback(
    (on: boolean) => {
      holdRef.current = on;
      if (!audioOk) return;
      if (on) preview.pause();
      else
        void preview.resume().then((ok) => {
          if (ok) setBlocked(false);
        });
    },
    [audioOk, preview],
  );

  const retrySound = useCallback(() => {
    void preview.resume().then((ok) => {
      setBlocked(!ok);
      if (ok) setSounding(true);
    });
  }, [preview]);

  const isUi = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest("[data-rewind-ui]");

  const onPointerDown = (e: ReactPointerEvent) => {
    if (isUi(e.target) || (e.pointerType === "mouse" && e.button !== 0)) return;
    const press = { id: e.pointerId, timer: null as ReturnType<typeof setTimeout> | null, held: false };
    press.timer = setTimeout(() => {
      press.held = true;
      setHold(true);
    }, HOLD_MS);
    pressRef.current = press;
  };

  const endPress = (e: ReactPointerEvent, tap: boolean) => {
    const press = pressRef.current;
    if (!press || press.id !== e.pointerId) return;
    pressRef.current = null;
    if (press.timer) clearTimeout(press.timer);
    if (press.held) {
      setHold(false);
      return;
    }
    if (!tap) return;
    if (blocked) retrySound();
    const r = columnRef.current?.getBoundingClientRect();
    const left = r ? r.left : 0;
    const width = r ? r.width : window.innerWidth;
    if (e.clientX < left + width * 0.33) prev();
    else next();
  };

  const toggleMute = () => {
    if (blocked) {
      setMuted(false);
      preview.setMuted(false);
      retrySound();
      return;
    }
    const m = !muted;
    setMuted(m);
    preview.setMuted(m);
  };

  // ---- frame values ----
  const card = cards[page];
  const c = card.duration > 0 ? elapsedRef.current / card.duration : 1;
  const a = (ambRef.current % AMBIENT_MS) / AMBIENT_MS;
  const aMotion = rm ? 0 : a; // big ambient motion (backdrop drift, blobs)
  const sw = switchRef.current;
  const since = clockRef.current - sw.at;
  const outgoing = sw.from != null && sw.from !== page && since < SWITCH_MS ? cards[sw.from] : null;
  const prevBackdrop = sw.from != null && sw.from !== page && since < BACKDROP_MS ? cards[sw.from] : null;
  const switchRaw = Math.max(0, Math.min(1, since / SWITCH_MS));
  const inV = sw.from == null ? 1 : Curves.easeOutCubic(switchRaw);
  const outV = Curves.easeInCubic(1 - switchRaw);
  const blur = Math.max(26, Math.min(64, vw * 0.035));

  const ctx: CardCtx = {
    rm,
    w: Math.max(0, area.w - 52),
    h: Math.max(0, area.h - 28),
    onDone: onClose,
    onReplay: restart,
  };

  const showEq = audioOk && !muted && !blocked && sounding;

  return (
    <div
      className="absolute inset-0 select-none overflow-hidden"
      style={{ touchAction: "manipulation", WebkitTouchCallout: "none" } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerUp={(e) => endPress(e, true)}
      onPointerCancel={(e) => endPress(e, false)}
      onPointerLeave={(e) => endPress(e, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {prevBackdrop && (
        <Backdrop
          key={`bg-${sw.from}`}
          gradient={prevBackdrop.gradient}
          coverId={prevBackdrop.trackId}
          phase={aMotion}
          opacity={1}
          blur={blur}
        />
      )}
      <Backdrop
        key={`bg-${page}`}
        gradient={card.gradient}
        coverId={card.trackId}
        phase={aMotion}
        opacity={prevBackdrop ? Math.min(1, since / BACKDROP_MS) : 1}
        blur={blur}
      />
      <Blobs phase={aMotion} palette={card.gradient} />

      <div
        ref={columnRef}
        className="relative mx-auto flex h-full w-full max-w-[480px] flex-col"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* Segmented progress bar: one segment per card. */}
        <div className="flex" style={{ padding: "10px 10px 2px" }}>
          {cards.map((k, i) => (
            <div key={k.key} className="flex-1" style={{ padding: "0 2px" }}>
              <div className="overflow-hidden" style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.24)" }}>
                <div
                  style={{
                    height: "100%",
                    background: "#fff",
                    width: `${(i < page ? 1 : i === page ? Math.min(1, c) : 0) * 100}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Top bar */}
        <div className="flex items-center" style={{ height: 48 }}>
          <div style={{ width: 18 }} />
          <Sparkles size={16} color="#fff" />
          <div style={{ width: 6 }} />
          <div className="text-white" style={{ fontWeight: 700, letterSpacing: 0.5 }}>
            Relay Rewind
          </div>
          <div style={{ width: 10 }} />
          {showEq && <Equalizer phase={a} />}
          <div className="flex-1" />
          {audioOk && (
            <button
              type="button"
              {...UI_ATTR}
              onClick={toggleMute}
              aria-label={blocked ? "Tap to enable sound" : muted ? "Unmute" : "Mute"}
              title={blocked ? "Tap to enable sound" : muted ? "Unmute" : "Mute"}
              className="flex h-10 items-center gap-1.5 rounded-full px-2.5 text-white transition hover:bg-white/10"
            >
              {blocked && (
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold">Tap for sound</span>
              )}
              {muted || blocked ? <VolumeX size={22} /> : <Volume2 size={22} />}
            </button>
          )}
          <CloseButton onClose={onClose} />
          <div style={{ width: 4 }} />
        </div>

        {/* Card area */}
        <div ref={areaRef} className="relative min-h-0 flex-1">
          {outgoing && sw.from != null && (
            <div
              key={`card-${sw.from}`}
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ padding: "4px 26px 24px", ...fxStyle(card.fx, outV, rm) }}
            >
              <div className="relative h-full w-full">{outgoing.render(1, a, ctx)}</div>
            </div>
          )}
          <div
            key={`card-${page}`}
            className="absolute inset-0"
            style={{ padding: "4px 26px 24px", ...fxStyle(card.fx, inV, rm) }}
          >
            <div className="relative h-full w-full">{card.render(revealT(card, elapsedRef.current), a, ctx)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- root ----

/**
 * Full-screen Rewind overlay for `year`. Render it only while open and close it
 * via `onClose`. It portals itself to <body>, fetches the year's stats and the
 * tracks they reference, pauses the main player (resuming it on close only if it
 * was playing), and plays each card's song on its own audio element.
 *
 * If you open it from your own click handler, also call `unlockRewindAudio()`
 * inside that handler so strict-autoplay browsers allow the music.
 */
export function RewindStory({ year, onClose }: { year: number; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<{ status: "loading" } | { status: "empty" } | { status: "ready"; data: RewindData }>(
    { status: "loading" },
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controls = useRef<Controls | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => setMounted(true), []);
  // Mounted from the opening click: prime the audio element while that gesture
  // still counts (the entry points also do this in their click handlers).
  useLayoutEffect(() => unlockRewindAudio(), []);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    loadRewind(year)
      .then((data) => {
        if (!alive) return;
        setState(data.stats?.hasData ? { status: "ready", data } : { status: "empty" });
      })
      .catch(() => {
        if (alive) setState({ status: "empty" });
      });
    return () => {
      alive = false;
    };
  }, [year]);

  // Focus the dialog; give focus back on close.
  useEffect(() => {
    if (!mounted) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    return () => prevFocus?.focus?.({ preventScroll: true });
  }, [mounted]);

  // Keyboard: captured on window so the app-wide player shortcuts (Space,
  // arrows, brackets) don't also fire while the story is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
          return;
        case "ArrowRight":
        case "Space":
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) controls.current?.next();
          return;
        case "ArrowLeft":
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) controls.current?.prev();
          return;
        case "ArrowUp":
        case "ArrowDown":
        case "BracketLeft":
        case "BracketRight":
          e.preventDefault();
          e.stopPropagation();
          return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Your ${year} Relay Rewind`}
      tabIndex={-1}
      className="fixed inset-0 overflow-hidden bg-black text-white outline-none"
      style={{ zIndex: 2147483000 }}
    >
      {state.status === "loading" && <Loading onClose={onClose} />}
      {state.status === "empty" && <NotEnough year={year} onClose={onClose} />}
      {state.status === "ready" && <Story data={state.data} onClose={onClose} controls={controls} />}
    </div>,
    document.body,
  );
}
