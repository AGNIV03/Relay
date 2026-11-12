"use client";

import { Cast } from "lucide-react";
import { usePlayer } from "@/context/PlayerContext";

/** Chromecast button. Hidden unless the browser can cast and a device is on the
 *  network; opens the browser's picker (which also offers "Stop casting"). Not
 *  shown to a Chorus member or while listening along, since neither plays audio
 *  of its own to hand over. */
export function CastButton({ size = 18 }: { size?: number }) {
  const p = usePlayer();
  if (p.isChorusMember || p.listeningAlong) return null;
  if (p.castState === "unavailable" || p.castState === "no-devices") return null;
  const connecting = p.castState === "connecting";
  const title = p.casting
    ? `Casting to ${p.castDevice ?? "a device"}`
    : connecting
      ? "Connecting..."
      : "Cast to a device";
  return (
    <button
      onClick={p.requestCast}
      title={title}
      className={`rounded-md p-1.5 transition hover:text-white ${
        p.casting ? "text-[var(--accent)]" : "text-[var(--muted)]"
      } ${connecting ? "animate-pulse" : ""}`}
    >
      <Cast size={size} />
    </button>
  );
}
