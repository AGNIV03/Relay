"use client";

import { useEffect, useRef } from "react";

/**
 * Pixel-style "squiggly" seek bar: the played portion is an animated sine wave
 * that ripples while playing; the remaining portion is a flat line. A thumb sits
 * at the play head. Click or drag anywhere to seek.
 */
export function SquigglyProgress({
  position,
  duration,
  playing,
  onSeek,
}: {
  position: number;
  duration: number;
  playing: boolean;
  onSeek: (sec: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const lineRef = useRef<SVGLineElement | null>(null);
  const thumbRef = useRef<SVGCircleElement | null>(null);

  // Mutable values read inside the rAF loop without re-subscribing.
  const realPos = useRef(0);
  const dispPos = useRef(0);
  const dur = useRef(0);
  const isPlaying = useRef(false);
  const dragging = useRef(false);
  realPos.current = position;
  dur.current = duration;
  isPlaying.current = playing;

  useEffect(() => {
    const H = 26;
    const mid = H / 2;
    const amp = 5; // gentle wave height
    const wavelength = 80; // long, rolling waves
    let phase = 0;
    let last = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const wrap = wrapRef.current;
      const path = pathRef.current;
      const line = lineRef.current;
      const thumb = thumbRef.current;
      if (!wrap || !path || !line || !thumb) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const W = wrap.clientWidth || 1;

      // Smoothly track the real position; coast forward while playing.
      if (!dragging.current) {
        if (isPlaying.current) dispPos.current += dt;
        dispPos.current += (realPos.current - dispPos.current) * Math.min(1, dt * 6);
      }
      const d = dur.current || 1;
      const frac = Math.max(0, Math.min(1, dispPos.current / d));
      const headX = frac * W;

      if (isPlaying.current && !dragging.current) phase += dt * 1.1; // slow, calm roll

      // Build the played wave path. Amplitude tapers to 0 at the head so the
      // wave meets the thumb cleanly (Pixel-style).
      let pd = `M 0 ${mid}`;
      const step = 3;
      for (let x = 0; x <= headX; x += step) {
        const distToHead = headX - x;
        const taper = Math.min(1, distToHead / 24);
        const y = mid + Math.sin(x / wavelength * Math.PI * 2 - phase) * amp * taper;
        pd += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      path.setAttribute("d", pd);
      line.setAttribute("x1", `${headX}`);
      line.setAttribute("x2", `${W}`);
      line.setAttribute("y1", `${mid}`);
      line.setAttribute("y2", `${mid}`);
      thumb.setAttribute("cx", `${headX}`);
      thumb.setAttribute("cy", `${mid}`);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekFromEvent = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap || !dur.current) return;
    const rect = wrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    dispPos.current = frac * dur.current;
    onSeek(frac * dur.current);
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-[26px] flex-1 cursor-pointer touch-none select-none"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        seekFromEvent(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) seekFromEvent(e.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <svg width="100%" height="26" className="overflow-visible">
        <line ref={lineRef} stroke="var(--border)" strokeWidth={4} strokeLinecap="round" />
        <path
          ref={pathRef}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle ref={thumbRef} r={6} fill="var(--accent)" />
      </svg>
    </div>
  );
}
