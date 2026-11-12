"use client";

// The Rewind card sequence, mirroring _buildCards() in
// app/lib/screens/rewind_screen.dart: same order, skip rules, track assignment,
// durations, reveal pacing, gradients, entrance effects and set pieces.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  Clock,
  Disc3,
  Headphones,
  Heart,
  Mic2,
  Music2,
  Radio,
  RefreshCw,
  Repeat,
  Share2,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import { coverUrl } from "@/lib/api";
import { ACCENT, ACCENT2, ACCENT_INK, Curves, MONTHS, fmt, rgba, seeded, seg } from "./anim";
import type { RewindData, RewindStats } from "./types";
import { shareRewindCard } from "./share";

export type Fx = "zoom" | "slideUp" | "swirl" | "slideSide";

export interface CardCtx {
  /** prefers-reduced-motion: tone down the big motion. */
  rm: boolean;
  /** Content box of the card area (inside the card padding), in px. */
  w: number;
  h: number;
  onDone: () => void;
  onReplay: () => void;
}

export interface CardDef {
  key: string;
  gradient: [string, string];
  trackId: string | null;
  /** How long the card stays up (ms). */
  duration: number;
  /** How long its reveal animations take (ms); the card then holds. */
  reveal: number;
  fx: Fx;
  /** t = reveal progress 0..1, a = ambient loop phase 0..1. */
  render: (t: number, a: number, ctx: CardCtx) => ReactNode;
}

/** Reveal progress (0..1) for `elapsed` ms of a card. */
export const revealT = (card: CardDef, elapsed: number) =>
  Math.max(0, Math.min(1, elapsed / card.reveal));

const WHITE70 = "rgba(255,255,255,0.7)";
const TAU = Math.PI * 2;

// ------------------------------------------------------------ primitives ----

/** Big type shrinks on screens narrower than the 390px phone it was designed for. */
const fs = (size: number) =>
  size >= 30 ? `min(${size}px, ${((size * 100) / 390).toFixed(2)}vw)` : `${size}px`;

const COL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "flex-start",
  width: "100%",
  height: "100%",
};

function Spacer({ h }: { h: number }) {
  return <div style={{ height: h, flexShrink: 0 }} />;
}

function rise(t: number, start: number, child: ReactNode, rm: boolean, stretch = false) {
  const p = Curves.easeOutCubic(seg(t, start, start + 0.16));
  return (
    <div
      style={{
        opacity: p,
        transform: rm ? undefined : `translateY(${22 * (1 - p)}px)`,
        maxWidth: "100%",
        minWidth: 0,
        alignSelf: stretch ? "stretch" : undefined,
      }}
    >
      {child}
    </div>
  );
}

function pop(t: number, start: number, child: ReactNode, rm: boolean) {
  const raw = seg(t, start, start + 0.22);
  return (
    <div
      style={{
        opacity: raw,
        transform: rm ? undefined : `scale(${0.6 + 0.4 * Curves.easeOutBack(raw)})`,
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      {child}
    </div>
  );
}

function slideIn(t: number, start: number, child: ReactNode, rm: boolean, key?: string | number) {
  const p = Curves.easeOutCubic(seg(t, start, start + 0.15));
  return (
    <div
      key={key}
      style={{
        opacity: p,
        transform: rm ? undefined : `translateX(${60 * (1 - p)}px)`,
        alignSelf: "stretch",
        minWidth: 0,
      }}
    >
      {child}
    </div>
  );
}

function Big({
  s,
  size,
  color,
  center = false,
  maxLines = 1,
}: {
  s: string;
  size: number;
  color: string;
  center?: boolean;
  maxLines?: number;
}) {
  const clampStyle: CSSProperties =
    maxLines === 1
      ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
      : {
          display: "-webkit-box",
          WebkitLineClamp: maxLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          overflowWrap: "anywhere",
        };
  return (
    <div
      style={{
        color,
        fontSize: fs(size),
        fontWeight: 900,
        lineHeight: 1.05,
        textAlign: center ? "center" : "start",
        maxWidth: "100%",
        ...clampStyle,
      }}
    >
      {s}
    </div>
  );
}

function GradientText({ s, size }: { s: string; size: number }) {
  return (
    <div
      style={{
        fontSize: fs(size),
        fontWeight: 900,
        lineHeight: 1.05,
        display: "inline-block",
        backgroundImage: `linear-gradient(90deg, ${ACCENT2}, #ffffff, #ff8fd8)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        whiteSpace: "nowrap",
      }}
    >
      {s}
    </div>
  );
}

function Label({ s, dark = false }: { s: string; dark?: boolean }) {
  return (
    <div
      style={{
        color: dark ? "rgba(0,0,0,0.54)" : WHITE70,
        fontSize: 14,
        fontWeight: 800,
        letterSpacing: 2,
      }}
    >
      {s}
    </div>
  );
}

function Pill({ s }: { s: string }) {
  return (
    <div
      style={{
        padding: "8px 14px",
        background: "rgba(255,255,255,0.2)",
        borderRadius: 999,
        color: "#fff",
        fontWeight: 700,
        fontSize: 15,
        display: "inline-block",
      }}
    >
      {s}
    </div>
  );
}

function Underline({ p }: { p: number }) {
  return (
    <div
      style={{
        width: 180 * Curves.easeOutCubic(p),
        height: 5,
        borderRadius: 3,
        background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT2})`,
      }}
    />
  );
}

/** Track cover with a quiet fallback when the image is missing. */
export function Cover({
  id,
  size,
  radius = 8,
  round = false,
  style,
}: {
  id: string;
  size: number | string;
  radius?: number;
  round?: boolean;
  style?: CSSProperties;
}) {
  const url = useMemo(() => coverUrl(id), [id]);
  const [err, setErr] = useState(false);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: round ? "50%" : radius,
        overflow: "hidden",
        background: "rgba(255,255,255,0.12)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {err ? (
        <Music2 size={typeof size === "number" ? size * 0.4 : 24} color="rgba(255,255,255,0.6)" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setErr(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}
    </div>
  );
}

function RankRow({
  rank,
  title,
  sub,
  coverId,
  round = false,
  glow = 0,
}: {
  rank: number;
  title: string;
  sub: string;
  coverId: string | null;
  round?: boolean;
  glow?: number;
}) {
  return (
    <div
      style={{
        margin: "5px 0",
        padding: 6,
        borderRadius: 14,
        background: `rgba(255,255,255,${0.08 + 0.12 * glow})`,
        boxShadow: glow > 0 ? `0 0 ${28 * glow}px ${rgba(ACCENT2, 0.5 * glow)}` : undefined,
        display: "flex",
        alignItems: "center",
        width: "100%",
      }}
    >
      <div style={{ width: 34, textAlign: "center", color: "#fff", fontSize: 24, fontWeight: 900, flexShrink: 0 }}>
        {rank}
      </div>
      <div style={{ width: 6, flexShrink: 0 }} />
      {coverId && <Cover id={coverId} size={46} radius={8} round={round} />}
      <div style={{ width: 12, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: "#fff",
            fontSize: 16,
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: WHITE70,
            fontSize: 13,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {sub}
        </div>
      </div>
    </div>
  );
}

function RecapRow({ icon: Icon, s }: { icon: LucideIcon; s: string }) {
  return (
    <div style={{ padding: "5px 0", display: "flex", alignItems: "center", width: "100%" }}>
      <Icon size={18} color={ACCENT2} style={{ flexShrink: 0 }} />
      <div style={{ width: 12, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          color: "#fff",
          fontSize: 16,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {s}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ set pieces ----

const FLOAT_XS = [0.62, 0.05, 0.72, 0.3, 0.5];
const FLOAT_YS = [0.08, 0.62, 0.66, 0.8, 0.3];
const FLOAT_ROTS = [0.12, -0.1, -0.06, 0.08, -0.14];

/** Covers drift up from below and bob gently behind the intro title. */
function floatingCover(id: string, i: number, t: number, a: number, rm: boolean) {
  const p = Curves.easeOutCubic(seg(t, 0.05 + i * 0.07, 0.45 + i * 0.07));
  const size = 92 + (i % 2) * 18;
  const bob = rm ? 0 : Math.sin((a + i * 0.21) * TAU) * 8;
  const drift = rm ? 0 : (1 - p) * 260;
  return (
    <div
      key={`fc${i}`}
      style={{
        position: "absolute",
        left: `${FLOAT_XS[i] * 100}%`,
        top: `calc(${FLOAT_YS[i] * 100}% + ${drift + bob}px)`,
        opacity: 0.55 * p,
        transform: `rotate(${FLOAT_ROTS[i]}rad)`,
        pointerEvents: "none",
      }}
    >
      <Cover id={id} size={size} radius={12} style={{ boxShadow: "0 0 20px rgba(0,0,0,0.45)" }} />
    </div>
  );
}

/** A vinyl record: black disc, grooves and a sheen (drawn once). */
function VinylDisc({ size }: { size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size * dpr);
    c.height = Math.round(size * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2;
    const r = size / 2;
    g.beginPath();
    g.arc(cx, cx, r, 0, TAU);
    g.fillStyle = "#111111";
    g.fill();
    g.lineWidth = 0.8;
    g.strokeStyle = "rgba(255,255,255,0.07)";
    for (let rr = r * 0.42; rr < r * 0.97; rr += 3.2) {
      g.beginPath();
      g.arc(cx, cx, rr, 0, TAU);
      g.stroke();
    }
    const conic = (g as CanvasRenderingContext2D & {
      createConicGradient?: (a: number, x: number, y: number) => CanvasGradient;
    }).createConicGradient;
    if (typeof conic === "function") {
      const sweep = conic.call(g, 0, cx, cx);
      sweep.addColorStop(0, "rgba(255,255,255,0)");
      sweep.addColorStop(0.25, "rgba(255,255,255,0.16)");
      sweep.addColorStop(0.5, "rgba(255,255,255,0)");
      sweep.addColorStop(0.75, "rgba(255,255,255,0.10)");
      sweep.addColorStop(1, "rgba(255,255,255,0)");
      g.beginPath();
      g.arc(cx, cx, r, 0, TAU);
      g.fillStyle = sweep;
      g.fill();
    }
  }, [size]);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: size, height: size }} />;
}

/** The record slides out of the sleeve, then keeps spinning. */
function vinyl(id: string, t: number, a: number, ctx: CardCtx) {
  const out = Curves.easeOutCubic(seg(t, 0.12, 0.42));
  const s = Math.min(1, ctx.w > 0 ? ctx.w / 310 : 1); // FittedBox.scaleDown
  const spin = ctx.rm ? 0 : a * 360 * 8;
  return (
    <div style={{ width: 310 * s, height: 200 * s, position: "relative" }}>
      <div
        style={{
          width: 310,
          height: 200,
          position: "absolute",
          left: 0,
          top: 0,
          transform: `scale(${s})`,
          transformOrigin: "0 0",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 10 + out * 105,
            top: 5,
            width: 190,
            height: 190,
            transform: `rotate(${spin}deg)`,
            willChange: "transform",
          }}
        >
          <VinylDisc size={190} />
          <div style={{ position: "absolute", left: 60, top: 60 }}>
            <Cover id={id} size={70} round />
          </div>
          <div
            style={{
              position: "absolute",
              left: 91,
              top: 91,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#000",
            }}
          />
        </div>
        <Cover
          id={id}
          size={200}
          radius={8}
          style={{ position: "absolute", left: 0, top: 0, boxShadow: "6px 8px 26px rgba(0,0,0,0.54)" }}
        />
      </div>
    </div>
  );
}

/** Expanding, fading rings around the top artist. */
function Rings({ phase }: { phase: number }) {
  const base = 85;
  const half = 130;
  return (
    <svg width={260} height={260} style={{ position: "absolute", inset: 0 }} aria-hidden>
      {[0, 1, 2].map((i) => {
        const q = (((phase * 4 + i / 3) % 1) + 1) % 1;
        return (
          <circle
            key={i}
            cx={130}
            cy={130}
            r={base + q * (half - base)}
            fill="none"
            stroke="#fff"
            strokeOpacity={0.5 * (1 - q)}
            strokeWidth={3}
          />
        );
      })}
    </svg>
  );
}

function bubble(t: number, a: number, i: number, name: string, rm: boolean) {
  const raw = seg(t, 0.12 + i * 0.1, 0.5 + i * 0.1);
  const popV = rm ? 1 : Curves.elasticOut(raw);
  const bob = rm ? 0 : Math.sin((a * 3 + i * 0.37) * TAU) * 5;
  const size = Math.max(14, Math.min(22, 22 - i * 2.5));
  return (
    <div
      key={`b${i}`}
      style={{
        transform: `translateY(${bob}px) scale(${popV})`,
        opacity: rm ? Curves.easeOut(raw) : 1,
        padding: `${size * 0.5}px ${size * 0.9}px`,
        background: i === 0 ? "#053d33" : "rgba(255,255,255,0.28)",
        borderRadius: 999,
        color: i === 0 ? "#fff" : "#053d33",
        fontSize: size,
        fontWeight: 800,
        lineHeight: 1.2,
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {name}
    </div>
  );
}

function monthChart(s: RewindStats, t: number, rm: boolean) {
  const mm = s.monthMinutes;
  const maxV = Math.max(1, ...mm);
  const h = 150;
  const ink = "#3a2d00";
  return (
    <div style={{ height: h + 22, display: "flex", alignItems: "flex-end", alignSelf: "stretch" }}>
      {mm.slice(0, 12).map((v, i) => {
        const k = seg(t, 0.05 + i * 0.03, 0.4 + i * 0.03);
        const grow = rm ? Curves.easeOutCubic(k) : Curves.easeOutBack(k);
        const peak = i === s.peakMonth;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              padding: "0 2.5px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
              alignItems: "stretch",
              height: "100%",
            }}
          >
            <div
              style={{
                height: Math.max(3, h * (v / maxV) * grow),
                background: peak ? ink : rgba(ink, 0.28),
                borderRadius: 4,
                flexShrink: 0,
              }}
            />
            <div style={{ height: 6, flexShrink: 0 }} />
            <div
              style={{
                color: rgba(ink, peak ? 1 : 0.6),
                fontSize: 11,
                fontWeight: 700,
                textAlign: "center",
                lineHeight: "16px",
              }}
            >
              {MONTHS[i][0]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function collage(s: RewindStats, a: number, rm: boolean) {
  const ids = s.topTracks.slice(0, 4).map((t) => t.id);
  if (!ids.length) return null;
  const angle = 0.08 + (rm ? 0 : Math.sin(a * TAU) * 0.03);
  return (
    <div
      style={{
        transform: `rotate(${angle}rad)`,
        padding: 4,
        background: "#fff",
        borderRadius: 10,
        boxShadow: "0 0 24px rgba(0,0,0,0.54)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 112,
          height: 112,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: 3,
        }}
      >
        {[0, 1, 2, 3].map((i) => (
          <Cover key={i} id={ids[i % ids.length]} size="100%" radius={4} />
        ))}
      </div>
    </div>
  );
}

interface Particle {
  x0: number;
  speed: number;
  sway: number;
  spin: number;
  color: string;
}

const CONFETTI_COLORS = ["#22d3ee", "#67e8f9", "#ff8fd8", "#ffd200", "#38ef7d", "#ffffff"];
let particles: Particle[] | null = null;
function confettiParticles(): Particle[] {
  if (particles) return particles;
  const rnd = seeded(7);
  particles = Array.from({ length: 70 }, () => ({
    x0: rnd(),
    speed: 0.7 + rnd() * 0.8,
    sway: rnd() * TAU,
    spin: (rnd() - 0.5) * 14,
    color: CONFETTI_COLORS[Math.floor(rnd() * CONFETTI_COLORS.length)],
  }));
  return particles;
}

/** A one-shot confetti burst falling across the recap card. */
function Confetti({ progress, w, h }: { progress: number; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    if (progress <= 0 || progress >= 1) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fade = progress > 0.8 ? (1 - progress) / 0.2 : 1;
    g.globalAlpha = fade;
    for (const p of confettiParticles()) {
      const y = -0.08 + progress * p.speed * 1.25;
      if (y > 1.05) continue;
      const x = p.x0 + Math.sin(progress * 6 + p.sway) * 0.04;
      g.save();
      g.translate(x * w, y * h);
      g.rotate(progress * p.spin);
      g.fillStyle = p.color;
      g.fillRect(-4, -2.5, 8, 5);
      g.restore();
    }
    g.globalAlpha = 1;
  }, [progress, w, h]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

// ---------------------------------------------------------- personality ----

/** A light, derived "listening personality" from breadth vs. repetition. */
export function personalityInfo(s: RewindStats): { name: string; blurb: string; icon: LucideIcon } {
  if (s.totalPlays === 0 || s.distinctTracks === 0) {
    return { name: "The Listener", blurb: "Music is always on", icon: Headphones };
  }
  const repeatRatio = s.totalPlays / s.distinctTracks; // higher = more replays
  const breadth = s.distinctArtists;
  if (repeatRatio >= 4) {
    return { name: "The Replayer", blurb: "When you love a song, you really love it", icon: Repeat };
  }
  if (breadth >= 60) return { name: "The Explorer", blurb: "Always hunting for something new", icon: Sparkles };
  if (breadth >= 25) return { name: "The Adventurer", blurb: "A little bit of everything", icon: Radio };
  if (repeatRatio >= 2) return { name: "The Loyalist", blurb: "You know what you like", icon: Heart };
  return { name: "The Specialist", blurb: "A carefully curated taste", icon: Disc3 };
}

function PersonalityBadge({ s }: { s: RewindStats }) {
  const { name, blurb, icon: Icon } = personalityInfo(s);
  return (
    <div
      style={{
        padding: "14px 20px 14px 16px",
        background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT2})`,
        borderRadius: 18,
        boxShadow: `0 0 28px ${rgba(ACCENT, 0.45)}`,
        display: "inline-flex",
        alignItems: "center",
        maxWidth: "100%",
      }}
    >
      <Icon size={34} color={ACCENT_INK} style={{ flexShrink: 0 }} />
      <div style={{ width: 12, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: ACCENT_INK, fontSize: 22, fontWeight: 900, lineHeight: 1.2 }}>{name}</div>
        <div style={{ color: ACCENT_INK, fontSize: 13 }}>{blurb}</div>
      </div>
    </div>
  );
}

/** Renders the recap as a 1080x1920 PNG and shares (or downloads) it. */
function ShareButton({ s }: { s: RewindStats }) {
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  async function onShare() {
    if (state === "busy") return;
    setState("busy");
    try {
      const { name, blurb } = personalityInfo(s);
      const r = await shareRewindCard(s, { name, blurb });
      setState(r === "downloaded" ? "saved" : "idle");
    } catch {
      setState("error");
    }
  }
  return (
    <button
      type="button"
      {...UI_ATTR}
      onClick={onShare}
      disabled={state === "busy"}
      className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-60"
      style={{ border: "1px solid rgba(255,255,255,0.54)" }}
    >
      <Share2 size={18} />
      {state === "busy"
        ? "Preparing…"
        : state === "saved"
          ? "Saved"
          : state === "error"
            ? "Try again"
            : "Share"}
    </button>
  );
}

// ---------------------------------------------------------------- cards ----

/** Stops a click inside the story from also counting as a tap-to-advance. */
export const UI_ATTR = { "data-rewind-ui": "" } as const;

export function buildCards(data: RewindData): CardDef[] {
  const s = data.stats;
  const tt = s.topTracks ?? [];
  const artists = s.topArtists ?? [];
  const genres = s.topGenres ?? [];
  const trackAt = (i: number): string | null =>
    i >= 0 && tt.length > i ? tt[i].id : tt.length ? tt[0].id : null;
  const cards: CardDef[] = [];

  // 1. Intro: covers float up behind the title.
  cards.push({
    key: "intro",
    gradient: ["#0f2027", "#2c5364"],
    trackId: trackAt(tt.length > 2 ? 2 : tt.length - 1),
    duration: 9500,
    reveal: 6500,
    fx: "zoom",
    render: (t, a, { rm }) => (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        {tt.slice(0, 5).map((x, i) => floatingCover(x.id, i, t, a, rm))}
        <div style={{ ...COL, position: "relative" }}>
          {rise(t, 0.0, <Big s="Your" size={34} color={WHITE70} />, rm)}
          {pop(t, 0.1, <Big s={String(s.year)} size={96} color="#fff" />, rm)}
          {rise(t, 0.24, <GradientText s="Rewind" size={54} />, rm)}
          <Spacer h={16} />
          {rise(
            t,
            0.4,
            <div style={{ color: WHITE70, fontSize: 16 }}>Let&apos;s play back your year in music</div>,
            rm,
          )}
        </div>
      </div>
    ),
  });

  // 2. Minutes listened: the hero number.
  cards.push({
    key: "minutes",
    gradient: ["#1d2671", "#c33764"],
    trackId: trackAt(1),
    duration: 11000,
    reveal: 7000,
    fx: "slideUp",
    render: (t, _a, { rm }) => {
      const shown = Math.round(s.totalMinutes * Curves.easeOutCubic(seg(t, 0.08, 0.6)));
      const hours = Math.round(s.totalMinutes / 60);
      const landed = seg(t, 0.58, 0.68);
      const bounce = rm ? 1 : 1 + 0.12 * Math.sin(landed * Math.PI); // little bounce as it lands
      return (
        <div style={COL}>
          {rise(t, 0.0, <div style={{ color: WHITE70, fontSize: 20 }}>This year you listened for</div>, rm)}
          <Spacer h={6} />
          <div
            style={{
              transform: `scale(${bounce})`,
              transformOrigin: "left center",
              color: "#fff",
              fontSize: fs(84),
              fontWeight: 900,
              lineHeight: 1.0,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {fmt(shown)}
          </div>
          <Big s="minutes" size={32} color={ACCENT2} />
          <Spacer h={6} />
          <Underline p={seg(t, 0.6, 0.8)} />
          <Spacer h={18} />
          {hours >= 2 && rise(t, 0.68, <Pill s={`That's about ${fmt(hours)} hours of music`} />, rm)}
          <Spacer h={10} />
          {rise(
            t,
            0.78,
            <div style={{ color: WHITE70, fontSize: 15 }}>
              {fmt(s.totalPlays)} plays across {fmt(s.distinctTracks)} songs
            </div>,
            rm,
          )}
        </div>
      );
    },
  });

  // 3. Top songs countdown (5 to 1); music stays on #2 to save #1 for its reveal.
  if (tt.length > 1) {
    cards.push({
      key: "countdown",
      gradient: ["#0f0c29", "#302b63"],
      trackId: trackAt(1),
      duration: 13000,
      reveal: 8500,
      fx: "slideSide",
      render: (t, _a, { rm }) => {
        const n = tt.length;
        return (
          <div style={COL}>
            {rise(t, 0.0, <Label s="YOUR TOP SONGS" />, rm)}
            <Spacer h={16} />
            {tt.map((x, i) =>
              slideIn(
                t,
                0.1 + (n - 1 - i) * 0.13, // reveal bottom-up: #5 first, #1 last
                <RankRow
                  rank={i + 1}
                  title={x.title}
                  sub={x.artist}
                  coverId={x.id}
                  glow={i === 0 ? seg(t, 0.1 + (n - 1) * 0.13 + 0.15, 1.0) : 0}
                />,
                rm,
                x.id + i,
              ),
            )}
          </div>
        );
      },
    });
  }

  // 4. #1 song: a record slides out of its sleeve and spins. Music switches to #1.
  if (tt.length) {
    const top = tt[0];
    const track = data.tracks[top.id];
    const minutesWith = track ? Math.round((top.playCount * (track.duration || 0)) / 60) : 0;
    cards.push({
      key: "topsong",
      gradient: ["#42275a", "#734b6d"],
      trackId: top.id,
      duration: 12500,
      reveal: 8000,
      fx: "swirl",
      render: (t, a, ctx) => {
        const { rm } = ctx;
        return (
          <div style={COL}>
            {rise(t, 0.0, <Label s={`YOUR #1 SONG OF ${s.year}`} />, rm)}
            <Spacer h={18} />
            {pop(t, 0.05, vinyl(top.id, t, a, ctx), rm)}
            <Spacer h={20} />
            {rise(t, 0.35, <Big s={top.title} size={32} color="#fff" maxLines={2} />, rm)}
            {rise(
              t,
              0.42,
              <div
                style={{
                  color: WHITE70,
                  fontSize: 18,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {top.artist}
              </div>,
              rm,
            )}
            <Spacer h={12} />
            {rise(t, 0.55, <Pill s={`Played ${fmt(top.playCount)} times`} />, rm)}
            {minutesWith > 0 && (
              <>
                <Spacer h={8} />
                {rise(t, 0.65, <Pill s={`That's ${fmt(minutesWith)} minutes on repeat`} />, rm)}
              </>
            )}
          </div>
        );
      },
    });
  }

  // 5. #1 artist: their cover with pulsing rings.
  if (artists.length) {
    const ar = artists[0];
    cards.push({
      key: "topartist",
      gradient: ["#ee0979", "#ff6a00"],
      trackId: ar.trackId,
      duration: 11000,
      reveal: 7000,
      fx: "zoom",
      render: (t, a, { rm }) => (
        <div style={{ ...COL, alignItems: "center" }}>
          {rise(t, 0.0, <Label s="YOUR #1 ARTIST" />, rm)}
          <Spacer h={18} />
          {pop(
            t,
            0.08,
            <div style={{ width: 260, height: 260, position: "relative", maxWidth: "100%" }}>
              <Rings phase={rm ? 0 : a} />
              <div
                style={{
                  position: "absolute",
                  left: 45,
                  top: 45,
                  width: 170,
                  height: 170,
                  borderRadius: "50%",
                  overflow: "hidden",
                }}
              >
                {ar.trackId ? (
                  <Cover id={ar.trackId} size={170} round />
                ) : (
                  <div
                    style={{
                      width: 170,
                      height: 170,
                      background: "rgba(255,255,255,0.24)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Mic2 size={70} color="#fff" />
                  </div>
                )}
              </div>
            </div>,
            rm,
          )}
          <Spacer h={14} />
          {pop(t, 0.3, <Big s={ar.name} size={44} color="#fff" center maxLines={2} />, rm)}
          <Spacer h={12} />
          {rise(t, 0.45, <Pill s={`${fmt(ar.count)} plays this year`} />, rm)}
        </div>
      ),
    });
  }

  // 6. Top artists list.
  if (artists.length > 1) {
    cards.push({
      key: "artists",
      gradient: ["#8e2de2", "#4a00e0"],
      trackId: artists[1].trackId ?? artists[0].trackId,
      duration: 11000,
      reveal: 7000,
      fx: "slideUp",
      render: (t, _a, { rm }) => (
        <div style={COL}>
          {rise(t, 0.0, <Label s="YOUR TOP ARTISTS" />, rm)}
          <Spacer h={16} />
          {artists.map((x, i) =>
            slideIn(
              t,
              0.1 + i * 0.12,
              <RankRow rank={i + 1} title={x.name} sub={`${fmt(x.count)} plays`} coverId={x.trackId} round />,
              rm,
              x.name + i,
            ),
          )}
        </div>
      ),
    });
  }

  // 7. Genres: bubbles that pop in and bob.
  if (genres.length) {
    cards.push({
      key: "genres",
      gradient: ["#11998e", "#38ef7d"],
      trackId: genres[0].trackId,
      duration: 11000,
      reveal: 7000,
      fx: "swirl",
      render: (t, a, { rm }) => (
        <div style={COL}>
          {rise(t, 0.0, <Label s="YOUR TOP GENRES" dark />, rm)}
          <Spacer h={6} />
          {rise(t, 0.05, <Big s={genres[0].name} size={46} color="#053d33" maxLines={2} />, rm)}
          <Spacer h={22} />
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 12, rowGap: 14, maxWidth: "100%" }}>
            {genres.map((g, i) => bubble(t, a, i, g.name, rm))}
          </div>
        </div>
      ),
    });
  }

  // 8. Peak month: the bars grow, the peak lights up.
  const peakMin = s.monthMinutes?.length === 12 ? s.monthMinutes[s.peakMonth] ?? 0 : 0;
  if (peakMin > 0) {
    cards.push({
      key: "peak",
      gradient: ["#f7971e", "#ffd200"],
      trackId: s.peakMonthTrackId ?? trackAt(0),
      duration: 11000,
      reveal: 7000,
      fx: "slideSide",
      render: (t, _a, { rm }) => (
        <div style={COL}>
          {rise(t, 0.0, <Label s="YOUR BIGGEST MONTH" dark />, rm)}
          <Spacer h={6} />
          {pop(t, 0.5, <Big s={MONTHS[s.peakMonth] ?? ""} size={58} color="#3a2d00" />, rm)}
          <Spacer h={4} />
          {rise(
            t,
            0.58,
            <div style={{ color: "#3a2d00", fontSize: 18, fontWeight: 600 }}>{fmt(peakMin)} minutes that month</div>,
            rm,
          )}
          <Spacer h={26} />
          {monthChart(s, t, rm)}
        </div>
      ),
    });
  }

  // 9. Breadth + listening personality (badge flips in).
  cards.push({
    key: "personality",
    gradient: ["#373B44", "#4286f4"],
    trackId: trackAt(2),
    duration: 11000,
    reveal: 7000,
    fx: "zoom",
    render: (t, _a, { rm }) => {
      const shownArtists = Math.round(s.distinctArtists * Curves.easeOut(seg(t, 0.05, 0.45)));
      const flip = Curves.easeOutBack(seg(t, 0.5, 0.75));
      return (
        <div style={COL}>
          {rise(t, 0.0, <div style={{ color: WHITE70, fontSize: 20 }}>You explored</div>, rm)}
          <div
            style={{
              color: "#fff",
              fontSize: fs(80),
              fontWeight: 900,
              lineHeight: 1.0,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmt(shownArtists)}
          </div>
          <Big s="different artists" size={28} color={ACCENT2} />
          <Spacer h={30} />
          {rise(t, 0.45, <div style={{ color: WHITE70, fontSize: 15 }}>Your listening personality</div>, rm)}
          <Spacer h={10} />
          <div
            style={{
              opacity: seg(t, 0.5, 0.56),
              transform: rm ? undefined : `perspective(667px) rotateY(${(1 - flip) * 90}deg)`,
              transformOrigin: "left center",
              maxWidth: "100%",
            }}
          >
            <PersonalityBadge s={s} />
          </div>
        </div>
      );
    },
  });

  // 10. Recap: cover collage, highlights, confetti, Done / Replay.
  cards.push({
    key: "recap",
    gradient: ["#232526", "#414345"],
    trackId: trackAt(0),
    duration: 14000,
    reveal: 9000,
    fx: "slideUp",
    render: (t, a, ctx) => {
      const { rm } = ctx;
      return (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <div style={COL}>
            <div style={{ display: "flex", alignItems: "center", alignSelf: "stretch" }}>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                {rise(t, 0.0, <Big s={`Your ${s.year}`} size={30} color={WHITE70} />, rm)}
                {rise(t, 0.06, <GradientText s="in music" size={40} />, rm)}
              </div>
              {pop(t, 0.1, collage(s, a, rm), rm)}
            </div>
            <Spacer h={22} />
            {rise(t, 0.2, <RecapRow icon={Clock} s={`${fmt(s.totalMinutes)} minutes`} />, rm, true)}
            {rise(
              t,
              0.28,
              <RecapRow icon={Music2} s={`${fmt(s.distinctTracks)} songs · ${fmt(s.distinctArtists)} artists`} />,
              rm,
              true,
            )}
            {tt.length > 0 && rise(t, 0.36, <RecapRow icon={Star} s={`Top song: ${tt[0].title}`} />, rm, true)}
            {artists.length > 0 &&
              rise(t, 0.44, <RecapRow icon={Mic2} s={`Top artist: ${artists[0].name}`} />, rm, true)}
            {genres.length > 0 &&
              rise(t, 0.52, <RecapRow icon={Disc3} s={`Top genre: ${genres[0].name}`} />, rm, true)}
            {rise(t, 0.6, <RecapRow icon={Sparkles} s={personalityInfo(s).name} />, rm, true)}
            <Spacer h={26} />
            {rise(
              t,
              0.7,
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  type="button"
                  {...UI_ATTR}
                  onClick={ctx.onDone}
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition hover:brightness-110"
                  style={{ background: ACCENT, color: ACCENT_INK }}
                >
                  <Check size={18} />
                  Done
                </button>
                <button
                  type="button"
                  {...UI_ATTR}
                  onClick={ctx.onReplay}
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
                  style={{ border: "1px solid rgba(255,255,255,0.54)" }}
                >
                  <RefreshCw size={18} />
                  Replay
                </button>
                <ShareButton s={s} />
              </div>,
              rm,
            )}
          </div>
          {!rm && <Confetti progress={seg(t, 0.05, 0.75)} w={ctx.w} h={ctx.h} />}
        </div>
      );
    },
  });

  return cards;
}
