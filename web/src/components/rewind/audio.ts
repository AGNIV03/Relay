// Rewind's background music runs on its OWN <audio> element, never the main
// player, so nothing is scrobbled, saved to the session or broadcast to friends.
// Mirrors the Flutter player's preview mode: each song starts ~30% in (capped at
// 75s), loops, and song changes fade out (350ms) then fade in (700ms).

import { streamUrl } from "@/lib/api";
import type { Track } from "@/lib/types";

let element: HTMLAudioElement | null = null;
let silentSrc: string | null = null;

function silentWav(): string {
  if (silentSrc) return silentSrc;
  const samples = 800; // 0.1s of 8-bit mono silence at 8kHz
  const buf = new Uint8Array(44 + samples);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + samples, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  w(36, "data");
  dv.setUint32(40, samples, true);
  buf.fill(128, 44);
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  silentSrc = `data:audio/wav;base64,${btoa(bin)}`;
  return silentSrc;
}

function previewElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = "auto";
    element.loop = true;
  }
  return element;
}

/**
 * Call synchronously inside the click/tap handler that opens Rewind. It plays a
 * silent clip on Rewind's audio element so browsers with strict autoplay rules
 * (Safari, Firefox) let that element play later, once the stats have loaded.
 * Safe to call more than once.
 */
export function unlockRewindAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const a = previewElement();
    const hasReal = !!a.getAttribute("src") && a.getAttribute("src") !== silentWav();
    if (hasReal) return;
    a.src = silentWav();
    a.play()
      .then(() => {
        if (a.getAttribute("src") === silentWav()) a.pause();
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

export type PreviewResult = "ok" | "blocked" | "error" | "cancelled";

const sleepFrame = () => new Promise<void>((r) => setTimeout(r, 16));

// Tokens are shared by every PreviewPlayer: they all drive the one element, so a
// newer story's load/fade must cancel an older one's lingering fade-out.
const shared = { load: 0, fade: 0 };

export class PreviewPlayer {
  /** Loudness the snippets fade up to (the main player's volume). */
  target = 1;
  private muted = false;
  private paused = false;

  private get el() {
    return previewElement();
  }

  private hasReal() {
    const src = this.el.getAttribute("src");
    return !!src && src !== silentSrc;
  }

  private async fadeTo(to: number, ms: number, token: number) {
    const a = this.el;
    const from = a.volume;
    const start = performance.now();
    for (;;) {
      if (token !== shared.fade) return;
      const k = Math.min(1, (performance.now() - start) / ms);
      a.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k >= 1) return;
      await sleepFrame();
    }
  }

  private waitReady(token: number): Promise<boolean> {
    const a = this.el;
    return new Promise((resolve) => {
      if (a.readyState >= 1) return resolve(true);
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        a.removeEventListener("loadedmetadata", onMeta);
        a.removeEventListener("error", onErr);
        clearTimeout(timer);
        resolve(ok && token === shared.load);
      };
      const onMeta = () => finish(true);
      const onErr = () => finish(false);
      const timer = setTimeout(() => finish(false), 12000);
      a.addEventListener("loadedmetadata", onMeta);
      a.addEventListener("error", onErr);
    });
  }

  /** Crossfade to `t`, starting ~30% in (past most intros, often near a chorus). */
  async play(t: Track): Promise<PreviewResult> {
    const token = ++shared.load;
    const a = this.el;
    if (!a.paused && this.hasReal()) await this.fadeTo(0, 350, ++shared.fade);
    if (token !== shared.load) return "cancelled";
    try {
      a.pause();
      a.loop = true;
      a.muted = this.muted;
      a.volume = 0;
      a.src = streamUrl(t.id);
      a.load();
    } catch {
      return "error";
    }
    const ok = await this.waitReady(token);
    if (token !== shared.load) return "cancelled";
    if (!ok) return "error";
    const secs = t.duration > 0 ? t.duration : Number.isFinite(a.duration) ? a.duration : 0;
    const start = Math.min(Math.max(0, secs * 0.3), 75);
    try {
      a.currentTime = start;
    } catch {
      /* not seekable yet; start from the top */
    }
    a.volume = 0;
    if (this.paused) return "ok"; // held: resume() picks it up
    try {
      await a.play();
    } catch (e) {
      if (token !== shared.load) return "cancelled";
      return (e as DOMException)?.name === "NotAllowedError" ? "blocked" : "error";
    }
    if (token !== shared.load) return "cancelled";
    await this.fadeTo(this.target, 700, ++shared.fade);
    return "ok";
  }

  /** Resume after a hold (or after the browser blocked autoplay). Must be called
   *  from a user gesture to recover from a block. Returns false if still blocked. */
  async resume(): Promise<boolean> {
    this.paused = false;
    const a = this.el;
    if (!this.hasReal() || a.readyState < 1) return true;
    if (!a.paused) return true;
    const token = shared.load;
    try {
      await a.play();
    } catch (e) {
      return (e as DOMException)?.name !== "NotAllowedError";
    }
    if (token === shared.load && a.volume < this.target) {
      await this.fadeTo(this.target, 700, ++shared.fade);
    }
    return true;
  }

  /** Hold-to-pause pauses the music too. */
  pause(): void {
    this.paused = true;
    try {
      this.el.pause();
    } catch {
      /* ignore */
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.el.muted = m;
  }

  /** Fade out, then stop and drop the source so the stream request ends. */
  async stop(ms = 300): Promise<void> {
    ++shared.load;
    const token = ++shared.fade;
    const a = this.el;
    this.paused = false;
    if (!a.paused && this.hasReal()) await this.fadeTo(0, ms, token);
    if (token !== shared.fade) return; // a new story took over the element
    try {
      a.pause();
      a.removeAttribute("src");
      a.load();
    } catch {
      /* ignore */
    }
  }
}
