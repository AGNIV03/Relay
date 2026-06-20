"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api, coverUrl } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime, fmtDateAdded } from "@/lib/format";
import type { Track } from "@/lib/types";
import { AddToPlaylist } from "@/components/AddToPlaylist";

export default function SongsPage() {
  const { user } = useAuth();
  const player = usePlayer();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [imgErr, setImgErr] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const res = await api.get<{ tracks: Track[] }>("/api/library/tracks?limit=500");
    // Newest first, Spotify "Liked Songs" style.
    const sorted = [...res.tracks].sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    );
    setTracks(sorted);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    api
      .get<Track[]>("/api/favorites")
      .then((list) => setFavs(new Set(list.map((t) => t.id))))
      .catch(() => {});
  }, [load]);

  // Refresh: admins trigger a library scan (picks up new files), then reload.
  // Non-admins just reload the list.
  async function refresh() {
    if (user?.role !== "ADMIN") {
      setLoading(true);
      await load();
      return;
    }
    setScanning(true);
    try {
      await api.post("/api/admin/scan");
      // Poll until the scan finishes.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api.get<{ scanning: boolean }>("/api/admin/scan");
        if (!s.scanning) break;
      }
      await load();
    } finally {
      setScanning(false);
    }
  }

  async function toggleFav(id: string) {
    const next = new Set(favs);
    if (next.has(id)) {
      next.delete(id);
      await api.del(`/api/favorites/${id}`).catch(() => {});
    } else {
      next.add(id);
      await api.put(`/api/favorites/${id}`).catch(() => {});
    }
    setFavs(next);
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Songs</h1>
          <p className="text-sm text-[var(--muted)]">{tracks.length} songs</p>
        </div>
        <div className="flex items-center gap-2">
          {tracks.length > 0 && (
            <button
              onClick={() => player.playQueue(tracks, 0)}
              className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--accent-2)]"
            >
              ▶ Play all
            </button>
          )}
          <button
            onClick={refresh}
            disabled={scanning}
            title={user?.role === "ADMIN" ? "Scan library for new files" : "Refresh list"}
            className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-medium hover:bg-[var(--panel-2)] disabled:opacity-50"
          >
            <span className={scanning ? "inline-block animate-spin" : ""}>↻</span>
            {scanning ? "Scanning…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : tracks.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-8 text-center text-[var(--muted)]">
          No songs yet. Drop audio files into your music folder and hit Refresh.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="w-10 px-3 py-2 text-center">#</th>
                <th className="px-3 py-2">Title</th>
                <th className="hidden px-3 py-2 md:table-cell">Album</th>
                <th className="hidden px-3 py-2 lg:table-cell">Date added</th>
                <th className="w-20 px-3 py-2"></th>
                <th className="w-16 px-3 py-2 text-right">🕑</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((t, i) => {
                const isCurrent = player.current?.id === t.id;
                return (
                  <tr
                    key={t.id}
                    className={`group border-b border-[var(--border)]/50 hover:bg-[var(--panel-2)] ${
                      isCurrent ? "bg-[var(--panel-2)]" : ""
                    }`}
                  >
                    <td
                      className="cursor-pointer px-3 py-2 text-center text-[var(--muted)]"
                      onClick={() => player.playQueue(tracks, i)}
                    >
                      <span className="group-hover:hidden">
                        {isCurrent && player.playing ? "♪" : i + 1}
                      </span>
                      <span className="hidden group-hover:inline">▶</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded bg-[var(--panel-2)]"
                          onClick={() => player.playQueue(tracks, i)}
                        >
                          {!imgErr.has(t.id) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={coverUrl(t.id)}
                              alt=""
                              className="h-full w-full object-cover"
                              onError={() => setImgErr((s) => new Set(s).add(t.id))}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center">♪</div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div
                            className={`cursor-pointer truncate font-medium ${
                              isCurrent ? "text-[var(--accent-2)]" : ""
                            }`}
                            onClick={() => player.playQueue(tracks, i)}
                          >
                            {t.title}
                          </div>
                          {t.artist?.id ? (
                            <Link
                              href={`/artists/${t.artist.id}`}
                              className="truncate text-xs text-[var(--muted)] hover:text-white hover:underline"
                            >
                              {t.artist.name}
                            </Link>
                          ) : (
                            <div className="truncate text-xs text-[var(--muted)]">
                              {t.artist?.name}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-[var(--muted)] md:table-cell">
                      {t.album?.id ? (
                        <Link href={`/albums/${t.album.id}`} className="hover:text-white hover:underline">
                          {t.album.title}
                        </Link>
                      ) : (
                        t.album?.title
                      )}
                    </td>
                    <td className="hidden px-3 py-2 text-[var(--muted)] lg:table-cell">
                      {fmtDateAdded(t.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                        <button onClick={() => toggleFav(t.id)} title="Favorite">
                          {favs.has(t.id) ? "❤️" : "🤍"}
                        </button>
                        <AddToPlaylist trackId={t.id} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--muted)]">
                      {fmtTime(t.duration)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
