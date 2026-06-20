"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Search, Upload, RefreshCw, Play, Music, X } from "lucide-react";
import { api, coverUrl, uploadFiles } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { usePlayer } from "@/context/PlayerContext";
import { fmtTime, fmtDateAdded } from "@/lib/format";
import type { Track } from "@/lib/types";
import { AddToPlaylist } from "@/components/AddToPlaylist";
import { LikeButton } from "@/components/LikeButton";

export default function SongsPage() {
  const { user } = useAuth();
  const player = usePlayer();
  const isAdmin = user?.role === "ADMIN";
  const [tracks, setTracks] = useState<Track[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (query: string) => {
    const params = new URLSearchParams({ limit: "500" });
    if (query.trim()) params.set("q", query.trim());
    const res = await api.get<{ tracks: Track[]; total: number }>(
      `/api/library/tracks?${params.toString()}`,
    );
    const sorted = query.trim()
      ? res.tracks
      : [...res.tracks].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    setTracks(sorted);
    setTotal(res.total);
    setLoading(false);
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function refresh() {
    if (!isAdmin) return load(q);
    setScanning(true);
    try {
      await api.post("/api/admin/scan");
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api.get<{ scanning: boolean }>("/api/admin/scan");
        if (!s.scanning) break;
      }
      await load(q);
      showToast("Library rescanned");
    } finally {
      setScanning(false);
    }
  }

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadPct(0);
    try {
      const r = await uploadFiles(Array.from(files), setUploadPct);
      showToast(`Uploaded ${r.added} song${r.added === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`);
      await load("");
      setQ("");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadPct(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Songs</h1>
          <p className="text-sm text-[var(--muted)]">{total} songs · original quality, lossless</p>
        </div>
        <div className="flex items-center gap-2">
          {tracks.length > 0 && (
            <button
              onClick={() => player.playQueue(tracks, 0)}
              className="flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110"
            >
              <Play size={16} /> Play all
            </button>
          )}
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploadPct !== null}
            title="Upload music — shared with everyone, auto-added to your Liked Songs"
            className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-medium hover:bg-[var(--panel-2)] disabled:opacity-50"
          >
            <Upload size={16} />
            {uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload"}
          </button>
          <button
            onClick={refresh}
            disabled={scanning}
            title={isAdmin ? "Scan library for new files" : "Refresh"}
            className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-medium hover:bg-[var(--panel-2)] disabled:opacity-50"
          >
            <RefreshCw size={16} className={scanning ? "animate-spin" : ""} />
            {scanning ? "Scanning…" : "Refresh"}
          </button>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".mp3,.flac,audio/mpeg,audio/flac"
        multiple
        className="hidden"
        onChange={(e) => onUpload(e.target.files)}
      />

      {/* Search bar */}
      <div className="relative mb-4 max-w-xl">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search songs, artists, albums…"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] py-2 pl-9 pr-9 outline-none focus:border-[var(--accent)]"
        />
        {q && (
          <button
            onClick={() => setQ("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {uploadPct !== null && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-[var(--panel-2)]">
          <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${uploadPct}%` }} />
        </div>
      )}

      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : tracks.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-8 text-center text-[var(--muted)]">
          {q ? `No songs matching “${q}”.` : "No songs yet. Use Upload to add music."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="w-10 px-3 py-2 text-center">#</th>
                <th className="px-3 py-2">Title</th>
                <th className="hidden px-3 py-2 md:table-cell">Album</th>
                <th className="hidden px-3 py-2 lg:table-cell">Added</th>
                <th className="w-20 px-3 py-2"></th>
                <th className="w-16 px-3 py-2 text-right">⏱</th>
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
                        {isCurrent && player.playing ? (
                          <Music size={14} className="mx-auto text-[var(--accent)]" />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <Play size={14} className="mx-auto hidden group-hover:block" />
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
                            <div className="flex h-full w-full items-center justify-center">
                              <Music size={16} className="text-[var(--muted)]" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div
                            className={`cursor-pointer truncate font-medium ${isCurrent ? "text-[var(--accent)]" : ""}`}
                            onClick={() => player.playQueue(tracks, i)}
                          >
                            {t.title}
                          </div>
                          <div className="truncate text-xs text-[var(--muted)]">{t.artist?.name}</div>
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 text-[var(--muted)] md:table-cell">
                      {t.album?.title}
                    </td>
                    <td className="hidden px-3 py-2 text-[var(--muted)] lg:table-cell">
                      {fmtDateAdded(t.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-3">
                        <LikeButton trackId={t.id} />
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

      {toast && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
