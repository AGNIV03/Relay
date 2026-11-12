// Rewind share card: draws a 1080x1920 story-sized PNG of the recap on a canvas,
// then hands it to the Web Share API (with the file) or downloads it.

import { coverUrl } from "@/lib/api";
import { ACCENT, ACCENT2, ACCENT_INK, fmt, rgba } from "./anim";
import type { RewindStats } from "./types";

const W = 1080;
const H = 1920;
const FONT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

/** Load an image for canvas use. CORS-mode so a cross-origin cover without CORS
 *  headers fails to load (and is skipped) instead of tainting the canvas. */
function loadImage(src: string, timeoutMs = 5000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Trim text with an ellipsis to fit `max` px in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Draw an image cropped to cover the box (like object-fit: cover). */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, size: number) {
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - s) / 2;
  const sy = (img.naturalHeight - s) / 2;
  ctx.drawImage(img, sx, sy, s, s, x, y, size, size);
}

async function drawCard(
  s: RewindStats,
  personality: { name: string; blurb: string },
  withImages: boolean,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const tt = (s.topTracks ?? []).slice(0, 5);
  const topArtist = s.topArtists?.[0]?.name;

  // Background + soft accent glows.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0f2027");
  bg.addColorStop(0.55, "#16181c");
  bg.addColorStop(1, "#232526");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  for (const [cx, cy, r, a] of [
    [W * 0.9, H * 0.08, 520, 0.28],
    [W * 0.05, H * 0.62, 600, 0.16],
  ] as const) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(ACCENT, a));
    g.addColorStop(1, rgba(ACCENT, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const [logo, ...covers] = withImages
    ? await Promise.all([loadImage("/logo.png"), ...tt.slice(0, 4).map((t) => loadImage(coverUrl(t.id)))])
    : [null];

  const PAD = 90;
  ctx.textBaseline = "alphabetic";

  // Branding row.
  let x = PAD;
  if (logo) {
    ctx.drawImage(logo, PAD, 92, 64, 64);
    x = PAD + 84;
  }
  ctx.fillStyle = "#ffffff";
  ctx.font = `800 52px ${FONT}`;
  ctx.fillText("Relay", x, 142);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText(`Rewind ${s.year}`, W - PAD, 140);
  ctx.textAlign = "left";

  // Title.
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `700 64px ${FONT}`;
  ctx.fillText(`Your ${s.year}`, PAD, 300);
  const tg = ctx.createLinearGradient(PAD, 0, PAD + 560, 0);
  tg.addColorStop(0, ACCENT);
  tg.addColorStop(1, ACCENT2);
  ctx.fillStyle = tg;
  ctx.font = `900 112px ${FONT}`;
  ctx.fillText("in music", PAD, 410);

  // Cover collage (2x2, white frame, slight tilt); missing covers become tiles.
  const loaded = covers.filter((c): c is HTMLImageElement => !!c);
  if (loaded.length > 0) {
    const cell = 170;
    const gap = 8;
    const box = cell * 2 + gap + 20;
    ctx.save();
    ctx.translate(W - PAD - box / 2, 370);
    ctx.rotate(0.08);
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 40;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, -box / 2, -box / 2, box, box, 18);
    ctx.fill();
    ctx.shadowBlur = 0;
    for (let i = 0; i < 4; i++) {
      const cx = -box / 2 + 10 + (i % 2) * (cell + gap);
      const cy = -box / 2 + 10 + Math.floor(i / 2) * (cell + gap);
      ctx.save();
      roundRect(ctx, cx, cy, cell, cell, 8);
      ctx.clip();
      drawCover(ctx, loaded[i % loaded.length], cx, cy, cell);
      ctx.restore();
    }
    ctx.restore();
  }

  // Minutes.
  let y = 620;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText("Minutes listened", PAD, y);
  ctx.fillStyle = "#ffffff";
  ctx.font = `900 150px ${FONT}`;
  ctx.fillText(fmt(s.totalMinutes), PAD, y + 150);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `500 36px ${FONT}`;
  ctx.fillText(`${fmt(s.distinctTracks)} songs · ${fmt(s.distinctArtists)} artists`, PAD, y + 215);

  // Top artist.
  y = 940;
  if (topArtist) {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText("Top artist", PAD, y);
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 76px ${FONT}`;
    ctx.fillText(fit(ctx, topArtist, W - PAD * 2), PAD, y + 88);
    y += 170;
  }

  // Top songs.
  if (tt.length > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText("Top songs", PAD, y);
    y += 30;
    const rowH = 92;
    tt.forEach((t, i) => {
      const ry = y + i * rowH;
      ctx.fillStyle = i === 0 ? ACCENT : "rgba(255,255,255,0.5)";
      ctx.font = `900 48px ${FONT}`;
      ctx.fillText(String(i + 1), PAD, ry + 58);
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 42px ${FONT}`;
      ctx.fillText(fit(ctx, t.title, W - PAD * 2 - 80), PAD + 80, ry + 44);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = `500 32px ${FONT}`;
      ctx.fillText(fit(ctx, t.artist, W - PAD * 2 - 80), PAD + 80, ry + 84);
    });
  }

  // Personality pill.
  const pillY = 1660;
  ctx.font = `900 50px ${FONT}`;
  const nameW = ctx.measureText(personality.name).width;
  ctx.font = `500 30px ${FONT}`;
  const blurbW = ctx.measureText(personality.blurb).width;
  const pillW = Math.min(W - PAD * 2, Math.max(nameW, blurbW) + 80);
  const pg = ctx.createLinearGradient(PAD, 0, PAD + pillW, 0);
  pg.addColorStop(0, ACCENT);
  pg.addColorStop(1, ACCENT2);
  ctx.save();
  ctx.shadowColor = rgba(ACCENT, 0.45);
  ctx.shadowBlur = 50;
  ctx.fillStyle = pg;
  roundRect(ctx, PAD, pillY, pillW, 150, 36);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = ACCENT_INK;
  ctx.font = `900 50px ${FONT}`;
  ctx.fillText(fit(ctx, personality.name, pillW - 80), PAD + 40, pillY + 70);
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(fit(ctx, personality.blurb, pillW - 80), PAD + 40, pillY + 116);

  // Footer.
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(`Relay Rewind · ${s.year}`, W - PAD, H - 60);
  ctx.textAlign = "left";

  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't render image"))), "image/png");
    } catch (e) {
      reject(e); // SecurityError if a cover somehow tainted the canvas
    }
  });
}

/** Render the share image. Falls back to a text-only card if images taint it. */
export async function renderShareCard(
  s: RewindStats,
  personality: { name: string; blurb: string },
): Promise<Blob> {
  try {
    return await toBlob(await drawCard(s, personality, true));
  } catch {
    return toBlob(await drawCard(s, personality, false));
  }
}

/** Share via the Web Share API when it accepts files, else download the PNG. */
export async function shareRewindCard(
  s: RewindStats,
  personality: { name: string; blurb: string },
): Promise<"shared" | "downloaded" | "cancelled"> {
  const blob = await renderShareCard(s, personality);
  const filename = `relay-rewind-${s.year}.png`;
  const file = new File([blob], filename, { type: "image/png" });
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `My ${s.year} Rewind`, text: `My ${s.year} in music on Relay` });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // Otherwise fall through to a download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}
