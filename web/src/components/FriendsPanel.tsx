"use client";

import { useEffect, useState } from "react";
import { Headphones, X, Music, Users } from "lucide-react";
import { api } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import type { Friend } from "@/lib/types";

/** Right-side panel: every other user, their now/last-played track, online ring,
 *  and a Listen Along toggle. Polls every 10s. */
export function FriendsPanel({ onClose }: { onClose?: () => void }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .get<Friend[]>("/api/social/friends")
        .then((f) => {
          if (active) {
            setFriends(f);
            setLoaded(true);
          }
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Users size={16} className="text-[var(--accent)]" />
          Friend activity
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] transition hover:text-white"
            title="Hide"
          >
            <X size={16} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">Loading…</div>
        ) : friends.length === 0 ? (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">No other users yet</div>
        ) : (
          friends.map((f) => <FriendRow key={f.id} f={f} />)
        )}
      </div>
    </aside>
  );
}

function FriendRow({ f }: { f: Friend }) {
  const p = usePlayer();
  const isHost = p.listenHostId === f.id;
  // Show the current/last track regardless of online state (never "Offline").
  const subtitle = f.track
    ? `${f.track.title} · ${f.track.artist?.name ?? ""}`
    : "No recent activity";
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--panel-2)]">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--panel-2)] text-xs font-bold ${
          f.online ? "ring-2 ring-[#1DB954] ring-offset-2 ring-offset-[var(--panel)]" : ""
        }`}
      >
        {f.username.charAt(0).toUpperCase() || "?"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{f.username}</div>
        <div className="flex items-center gap-1 truncate text-xs text-[var(--muted)]">
          {f.track && <Music size={11} className="shrink-0" />}
          <span className="truncate">{subtitle}</span>
        </div>
      </div>
      {isHost ? (
        <button
          onClick={() => p.stopListenAlong()}
          title="Stop listening along"
          className="shrink-0 rounded-full p-1.5 text-[var(--accent)] transition"
        >
          <X size={16} />
        </button>
      ) : (
        // Listen-along only for an online friend; hidden once they go offline.
        f.online &&
        f.track && (
          <button
            onClick={() => p.startListenAlong(f.id, f.username)}
            title="Listen along"
            className="shrink-0 rounded-full p-1.5 text-[var(--muted)] transition hover:text-white"
          >
            <Headphones size={16} />
          </button>
        )
      )}
    </div>
  );
}

/** Thin bar above the player controls while a listen-along session is active. */
export function ListenAlongBar() {
  const p = usePlayer();
  if (!p.listeningAlong) return null;
  return (
    <div className="flex items-center gap-2 bg-[var(--accent)]/15 px-4 py-1.5 text-xs text-[var(--accent)]">
      <Headphones size={14} />
      <span className="flex-1 font-medium">Listening with {p.listenHostName}</span>
      <button
        onClick={p.stopListenAlong}
        className="rounded px-2 py-0.5 font-semibold transition hover:bg-[var(--accent)]/20"
      >
        Stop
      </button>
    </div>
  );
}
