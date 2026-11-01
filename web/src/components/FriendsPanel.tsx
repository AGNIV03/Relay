"use client";

import { useEffect, useState } from "react";
import { Headphones, X, Music, Users, Radio, UserPlus, Check, EyeOff } from "lucide-react";
import { api } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import type { Friend } from "@/lib/types";
import { UserProfileDialog } from "./UserProfileDialog";

/** Right-side panel: every other user, their now/last-played track, online ring,
 *  and a Listen Along toggle. Polls every 10s. */
export function FriendsPanel({ onClose }: { onClose?: () => void }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);

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
          friends.map((f) => <FriendRow key={f.id} f={f} onOpen={() => setProfileId(f.id)} />)
        )}
      </div>
      <ChorusSection />
      {profileId && (
        <UserProfileDialog userId={profileId} onClose={() => setProfileId(null)} />
      )}
    </aside>
  );
}

function FriendRow({ f, onOpen }: { f: Friend; onOpen: () => void }) {
  const p = usePlayer();
  const isHost = p.listenHostId === f.id;
  // Per-viewer relationship status takes priority over the now-playing line.
  const status = f.inChorusWithYou
    ? "In a chorus with you"
    : f.listeningToYou
      ? "Listening along with you"
      : null;
  // Show the current/last track regardless of online state (never "Offline").
  // Friends who don't share activity only expose their online status.
  const subtitle = f.private
    ? "Activity is private"
    : f.track
      ? `${f.track.title} · ${f.track.artist?.name ?? ""}`
      : "No recent activity";
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--panel-2)]">
      <button
        onClick={onOpen}
        title={`View ${f.username}'s profile`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--panel-2)] text-xs font-bold ${
            f.online ? "ring-2 ring-[#1DB954] ring-offset-2 ring-offset-[var(--panel)]" : ""
          }`}
        >
          {f.username.charAt(0).toUpperCase() || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{f.username}</div>
          {status ? (
            <div className="flex items-center gap-1 truncate text-xs font-medium text-[var(--accent)]">
              <Radio size={11} className="shrink-0" />
              <span className="truncate">{status}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 truncate text-xs text-[var(--muted)]">
              {f.private ? (
                <EyeOff size={11} className="shrink-0" />
              ) : (
                f.track && <Music size={11} className="shrink-0" />
              )}
              <span className="truncate">{subtitle}</span>
            </div>
          )}
        </div>
      </button>
      {/* Join Chorus (friend is hosting, and we aren't already a member of one).
          With auto-start most users always host their own, so we gate on member
          status — joining/following ends our own auto-chorus. */}
      {f.chorusMode && p.chorus?.hostId !== f.id && !p.isChorusMember && (
        <button
          onClick={async () => {
            const status = await p.joinChorus(f.id);
            void status;
          }}
          title={f.chorusMode === "ask" ? "Ask to join Chorus" : "Join Chorus"}
          className="shrink-0 rounded-full p-1.5 text-[var(--accent)] transition hover:brightness-125"
        >
          {f.chorusMode === "ask" ? <UserPlus size={16} /> : <Radio size={16} />}
        </button>
      )}
      {isHost ? (
        <button
          onClick={() => p.stopListenAlong()}
          title="Stop listening along"
          className="shrink-0 rounded-full p-1.5 text-[var(--accent)] transition"
        >
          <X size={16} />
        </button>
      ) : (
        // Listen-along for an online friend; hidden once they go offline, when
        // they don't allow it (private / listen-along off), or when we're a
        // silent chorus member.
        f.online &&
        f.track &&
        f.allowListenAlong !== false &&
        !p.isChorusMember && (
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

/** A compact pill on/off switch. */
function Toggle({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        on ? "bg-[var(--accent)]" : "bg-[var(--panel-2)]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** Small round avatar with the user's initial. */
function Initial({ name }: { name: string }) {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--panel-2)] text-[11px] font-bold">
      {name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}

/** Bottom-of-panel Chorus controls: a header on/off toggle, plus the listener
 *  list, join requests, and open/ask mode for the host. */
function ChorusSection() {
  const p = usePlayer();
  const c = p.chorus;

  // Nothing in progress and nothing playing to host → hide entirely.
  if (!c && !p.current) return null;

  const active = !!c && !c.isPending;
  const pending = !!c && c.isPending;
  const isHost = !!c && c.isHost;
  const on = active || pending;

  // The toggle next to "Chorus" turns it on/off: off ends (host) / leaves
  // (member) / cancels (pending); on starts a new open chorus.
  const toggle = () => (c ? p.leaveChorus() : p.startChorus("open"));

  return (
    <div className="border-t border-[var(--border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <Radio size={16} className={on ? "text-[var(--accent)]" : "text-[var(--muted)]"} />
        <span className="flex-1 text-sm font-semibold">
          {active && !isHost ? `${c!.hostName}'s Chorus` : "Chorus"}
        </span>
        <Toggle on={on} onToggle={toggle} title={on ? "Turn off Chorus" : "Start a Chorus"} />
      </div>

      {pending && (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Waiting for {c!.hostName} to approve your request…
        </p>
      )}
      {!c && (
        <p className="mt-1.5 text-xs text-[var(--muted)]">
          Listen together — friends join and control the music.
        </p>
      )}

      {active && (
        <div className="mt-3 space-y-3">
          {isHost && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">Open to anyone</span>
              <Toggle
                on={c!.mode === "open"}
                onToggle={() => p.setChorusMode(c!.mode === "open" ? "ask" : "open")}
                title="Anyone can join without asking"
              />
            </div>
          )}

          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
              Listeners · {c!.members.length}
            </div>
            <div className="space-y-0.5">
              {c!.members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded px-1 py-1 hover:bg-[var(--panel-2)]"
                >
                  <Initial name={m.username} />
                  <span className="flex-1 truncate text-sm">{m.username}</span>
                  {m.id === c!.hostId ? (
                    <span className="text-[10px] font-semibold uppercase text-[var(--accent)]">
                      Host
                    </span>
                  ) : (
                    isHost && (
                      <button
                        onClick={() => p.removeFromChorus(m.id)}
                        title="Remove listener"
                        className="text-[var(--muted)] transition hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          </div>

          {isHost && c!.pending.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Requests · {c!.pending.length}
              </div>
              <div className="space-y-0.5">
                {c!.pending.map((req) => (
                  <div key={req.id} className="flex items-center gap-2 rounded px-1 py-1">
                    <Initial name={req.username} />
                    <span className="flex-1 truncate text-sm">{req.username}</span>
                    <button
                      onClick={() => p.approveChorus(req.id)}
                      title="Approve"
                      className="text-[var(--accent)] transition hover:brightness-125"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      onClick={() => p.denyChorus(req.id)}
                      title="Deny"
                      className="text-[var(--muted)] transition hover:text-white"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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
