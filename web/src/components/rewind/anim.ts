// Small animation + formatting helpers for Relay Rewind, mirroring the Flutter
// curves used by app/lib/screens/rewind_screen.dart.

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Progress of t through the window [a, b], clamped to 0..1 (Dart `_p`). */
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

/** Flutter `Cubic` (bisection, same tolerance as Flutter's implementation). */
function cubic(a: number, b: number, c: number, d: number) {
  const ev = (f: number, g: number, m: number) =>
    3 * f * (1 - m) * (1 - m) * m + 3 * g * (1 - m) * m * m + m * m * m;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = 0;
    let e = 1;
    for (let i = 0; i < 40; i++) {
      const m = (s + e) / 2;
      const est = ev(a, c, m);
      if (Math.abs(t - est) < 0.001) return ev(b, d, m);
      if (est < t) s = m;
      else e = m;
    }
    return ev(b, d, (s + e) / 2);
  };
}

export const Curves = {
  easeOut: cubic(0.0, 0.0, 0.58, 1.0),
  easeOutCubic: cubic(0.215, 0.61, 0.355, 1.0),
  easeInCubic: cubic(0.55, 0.055, 0.675, 0.19),
  easeOutBack: cubic(0.175, 0.885, 0.32, 1.275),
  /** Flutter ElasticOutCurve(period: 0.4). */
  elasticOut: (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const period = 0.4;
    const s = period / 4;
    return Math.pow(2, -10 * t) * Math.sin(((t - s) * (Math.PI * 2)) / period) + 1;
  },
};

/** 12345 -> "12,345" */
export function fmt(n: number): string {
  const s = String(Math.round(n));
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Tiny seeded PRNG (mulberry32) so the confetti is the same every time. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "#rrggbb" + alpha -> "rgba(...)" */
export function rgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export const ACCENT = "#22d3ee";
export const ACCENT2 = "#67e8f9";
export const ACCENT_INK = "#08272c";
export const MUTED = "#a1a1aa";
