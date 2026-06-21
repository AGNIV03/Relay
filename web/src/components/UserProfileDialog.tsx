"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Music, Heart, ListMusic, Play } from "lucide-react";
import { api, coverUrl } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import type { UserProfile } from "@/lib/types";

/** Popup with a user's details, favorite songs, and playlists. */
export function UserProfileDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const player = usePlayer();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api
      .get<UserProfile>(`/api/social/users/${userId}`)
      .then((p) => active && setProfile(p))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [userId]);

  const joined = profile?.createdAt
    ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long" })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-[var(--border)] p-5">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] text-2xl font-bold text-[var(--accent-ink)]">
            {profile?.username.charAt(0).toUpperCase() ?? "?"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-bold">{profile?.username ?? "…"}</div>
            <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
              {profile?.role}
              {joined && <span className="normal-case"> · joined {joined}</span>}
            </div>
            {profile && (
              <div className="mt-1 flex gap-4 text-xs text-[var(--muted)]">
                <span className="flex items-center gap-1">
                  <Heart size={12} /> {profile.likeCount} liked
                </span>
                <span className="flex items-center gap-1">
                  <ListMusic size={12} /> {profile.playlists.length} playlists
                </span>
              </div>
            )}
          </div>
          <button onClick={onClose} className="self-start text-[var(--muted)] hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-6 text-center text-sm text-[var(--muted)]">Loading…</div>
          ) : !profile ? (
            <div className="py-6 text-center text-sm text-[var(--muted)]">Couldn’t load profile.</div>
          ) : (
            <>
              {profile.favorites.length > 0 && (
                <section className="mb-5">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    Favorite songs
                  </h4>
                  <div className="space-y-1">
                    {profile.favorites.slice(0, 30).map((t, i) => (
                      <button
                        key={t.id}
                        onClick={() => player.playQueue(profile.favorites, i)}
                        className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--panel-2)]"
                      >
                        <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded bg-[var(--panel-2)]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={coverUrl(t.id)} alt="" className="h-full w-full object-cover" />
                          <div className="absolute inset-0 hidden items-center justify-center bg-black/40 group-hover:flex">
                            <Play size={14} className="text-white" />
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{t.title}</div>
                          <div className="truncate text-xs text-[var(--muted)]">{t.artist?.name}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {profile.playlists.length > 0 && (
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    Playlists
                  </h4>
                  <div className="space-y-1">
                    {profile.playlists.map((pl) => (
                      <button
                        key={pl.id}
                        onClick={() => {
                          onClose();
                          router.push(`/playlists/${pl.id}`);
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--panel-2)]"
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[var(--panel-2)]">
                          <ListMusic size={16} className="text-[var(--muted)]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{pl.name}</div>
                          <div className="text-xs text-[var(--muted)]">{pl.trackCount} songs</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {profile.favorites.length === 0 && profile.playlists.length === 0 && (
                <div className="py-6 text-center text-sm text-[var(--muted)]">
                  <Music size={20} className="mx-auto mb-2 opacity-50" />
                  No favorites or playlists yet.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
