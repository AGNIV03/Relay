"use client";

import { useEffect, useState } from "react";
import { Headphones, X, Music, Users, Radio, UserPlus, Check } from "lucide-react";
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
  // Show the current/last track regardless of online state (never "Offline").
  const subtitle = f.track
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
          <div className="flex items-center gap-1 truncate text-xs text-[var(--muted)]">
            {f.track && <Music size={11} className="shrink-0" />}
            <span className="truncate">{subtitle}</span>
          </div>
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
        // Listen-along for an online friend; hidden once they go offline / when
        // we're a silent chorus member.
        f.online &&
        f.track &&
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

/** Bottom-of-panel Chorus controls: start one (when playing) or manage the active
 *  session (members, requests, mode, leave). */
function ChorusSection() {
  const p = usePlayer();
  const [open, setOpen] = useState(true);
  const c = p.chorus;

  if (c && c.isPending) {
    return (
      <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-3 text-sm">
        <UserPlus size={15} className="text-[var(--accent)]" />
        <span className="flex-1 truncate text-[var(--muted)]">
          Requested to join {c.hostName}&apos;s Chorus
        </span>
        <button
          onClick={() => p.leaveChorus()}
          className="text-xs font-medium text-[var(--muted)] hover:text-white"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (c) {
    return (
      <div className="border-t border-[var(--border)] bg-[var(--accent)]/8 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <Radio size={15} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-semibold text-[var(--accent)]">
            {c.isHost ? "Your Chorus" : `${c.hostName}'s Chorus`}
          </span>
          <button
            onClick={() => p.leaveChorus()}
            className="text-xs font-medium text-[var(--muted)] hover:text-white"
          >
            {c.isHost ? "End" : "Leave"}
          </button>
        </div>
        {c.isHost && (
          <label className="mb-2 flex items-center justify-between text-xs text-[var(--muted)]">
            Open to anyone
            <input
              type="checkbox"
              checked={c.mode === "open"}
              onChange={(e) => p.setChorusMode(e.target.checked ? "open" : "ask")}
            />
          </label>
        )}
        <div className="flex flex-wrap gap-1.5">
          {c.members.map((m) => (
            <span
              key={m.id}
              className="flex items-center gap-1 rounded-full bg-[var(--panel-2)] px-2 py-0.5 text-xs"
            >
              {m.id === c.hostId ? `${m.username} (host)` : m.username}
              {c.isHost && m.id !== c.hostId && (
                <button
                  onClick={() => p.removeFromChorus(m.id)}
                  className="text-[var(--muted)] hover:text-red-400"
                  title="Remove"
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
        {c.isHost && c.pending.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-xs text-[var(--muted)]">Requests</div>
            {c.pending.map((req) => (
              <div key={req.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{req.username}</span>
                <button
                  onClick={() => p.approveChorus(req.id)}
                  title="Approve"
                  className="text-[var(--accent)]"
                >
                  <Check size={16} />
                </button>
                <button
                  onClick={() => p.denyChorus(req.id)}
                  title="Deny"
                  className="text-[var(--muted)] hover:text-white"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!p.current) return null; // nothing playing → nothing to start
  return (
    <div className="border-t border-[var(--border)] px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Radio size={15} className="text-[var(--accent)]" /> Start a Chorus
      </div>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Listen together — friends join and control the music.
      </p>
      <div className="flex items-center gap-2">
        <div className="flex rounded-full bg-[var(--panel-2)] p-0.5 text-xs">
          {(["open", "ask"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setOpen(m === "open")}
              className={`rounded-full px-2.5 py-1 font-medium transition ${
                (m === "open") === open
                  ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                  : "text-[var(--muted)]"
              }`}
            >
              {m === "open" ? "Open" : "Ask to join"}
            </button>
          ))}
        </div>
        <button
          onClick={() => p.startChorus(open ? "open" : "ask")}
          className="ml-auto rounded-full bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)]"
        >
          Start
        </button>
      </div>
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
