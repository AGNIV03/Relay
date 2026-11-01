"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Search, Upload, RefreshCw, Play, Music, X, Shuffle, TriangleAlert } from "lucide-react";
import { api, coverUrl, uploadManyFiles, type RejectedUpload } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { usePlayer } from "@/context/PlayerContext";
import { useLiked } from "@/context/LikedContext";
import { fmtTime, fmtDateAdded } from "@/lib/format";
import type { Track } from "@/lib/types";
import { AddToPlaylist } from "@/components/AddToPlaylist";
import { LikeButton } from "@/components/LikeButton";
import { BulkBar } from "@/components/BulkBar";
import { SortMenu } from "@/components/SortMenu";
import { pickSort, seededShuffle, type SortState } from "@/lib/trackSort";

type SongOrder = "random" | "title" | "artist" | "album" | "added";
const SONG_SORTS: { key: SongOrder; label: string }[] = [
  { key: "random", label: "Shuffle" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "added", label: "Date added" },
];

export default function SongsPage() {
  const { user } = useAuth();
  const player = usePlayer();
  const liked = useLiked();
  const isAdmin = user?.role === "ADMIN";
  const [loaded, setLoaded] = useState<Track[]>([]); // as returned by the server
  // Songs default to a random order. A per-visit seed keeps it stable across
  // re-renders/reloads; picking "Shuffle" in the sort menu reshuffles.
  const [sort, setSort] = useState<SortState<SongOrder>>({ order: "random", asc: true });
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 32));
  const [rejected, setRejected] = useState<RejectedUpload[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  // The displayed (and played) order.
  const tracks = useMemo(() => {
    if (sort.order === "random") return seededShuffle(loaded, seed);
    const key = (t: Track): string => {
      switch (sort.order) {
        case "title":
          return t.title.toLowerCase();
        case "artist":
          return (t.artist?.name ?? "").toLowerCase();
        case "album":
          return (t.album?.title ?? "").toLowerCase();
        default:
          return t.createdAt ?? "";
      }
    };
    const l = [...loaded].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.asc ? l : l.reverse();
  }, [loaded, sort, seed]);

  function onPickSort(o: SongOrder) {
    if (o === "random") {
      setSort({ order: "random", asc: true });
      setSeed(Math.floor(Math.random() * 2 ** 32)); // re-randomize
    } else {
      setSort((s) => pickSort(s, o));
    }
  }

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearSel = () => setSelected(new Set());
  const allVisibleSelected = tracks.length > 0 && tracks.every((t) => selected.has(t.id));
  const toggleAll = () =>
    setSelected((s) => (tracks.every((t) => s.has(t.id)) ? new Set() : new Set(tracks.map((t) => t.id))));
  // Drop selections that no longer exist after a reload/search.
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const ids = new Set(tracks.map((t) => t.id));
      const n = new Set([...s].filter((id) => ids.has(id)));
      return n.size === s.size ? s : n;
    });
  }, [tracks]);

  const load = useCallback(async (query: string) => {
    const params = new URLSearchParams({ limit: "500" });
    if (query.trim()) params.set("q", query.trim());
    const res = await api.get<{ tracks: Track[]; total: number }>(
      `/api/library/tracks?${params.toString()}`,
    );
    setLoaded(res.tracks);
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
    setRejected([]);
    try {
      // Handles any count/size: small files batched under the CDN cap, large
      // files chunked individually.
      const { added, duplicates, failed, rejected } = await uploadManyFiles(
        Array.from(files),
        setUploadPct,
      );
      // Files with no playable audio are refused by the server: list which ones
      // and why (below the search bar) so the user knows to find a good copy.
      setRejected(rejected);
      showToast(
        `Uploaded ${added} song${added === 1 ? "" : "s"}` +
          (duplicates ? `, ${duplicates} already in library` : "") +
          (failed ? `, ${failed} rejected` : ""),
      );
      liked.refresh(); // uploads are auto-liked — refresh hearts
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
            <>
              <button
                // With shuffle on, a whole-list Play randomizes the first song too.
                onClick={() => player.playQueue(tracks, 0, { anchorStart: false })}
                className="flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110"
              >
                <Play size={16} /> Play all
              </button>
              <button
                onClick={() => player.shuffleAndPlay(tracks)}
                title="Shuffle play"
                className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-medium hover:bg-[var(--panel-2)]"
              >
                <Shuffle size={16} /> Shuffle
              </button>
            </>
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
        accept=".mp3,.flac,.m4a,.aac,.ogg,.opus,.wav,audio/*"
        multiple
        className="hidden"
        onChange={(e) => onUpload(e.target.files)}
      />

      {/* Search bar + sort */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-xl flex-1">
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
        <SortMenu
          options={SONG_SORTS}
          order={sort.order}
          asc={sort.asc}
          onPick={onPickSort}
          shuffleKey="random"
          align="left"
        />
      </div>

      {rejected.length > 0 && (
        <div className="mb-4 max-w-xl rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm">
          <div className="mb-1 flex items-center gap-2 font-medium text-red-300">
            <TriangleAlert size={15} className="shrink-0" />
            <span className="flex-1">
              {rejected.length === 1
                ? "1 file wasn't added"
                : `${rejected.length} files weren't added`}
            </span>
            <button
              onClick={() => setRejected([])}
              className="text-[var(--muted)] hover:text-white"
              title="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
          <ul className="space-y-0.5">
            {rejected.map((r, i) => (
              <li key={`${r.name}-${i}`} className="truncate text-[var(--muted)]">
                <span className="text-[var(--text)]">{r.name}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {uploadPct !== null && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-[var(--panel-2)]">
          <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${uploadPct}%` }} />
        </div>
      )}

      {selected.size > 0 && (
        <BulkBar ids={[...selected]} onClear={clearSel} onChanged={() => load(q)} />
      )}

      {tracks.length > 0 && selected.size === 0 && (
        <p className="mb-2 text-xs italic text-[var(--muted)]">
          Click and hold or right click to select multiple tracks
        </p>
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
                <th className="w-8 px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    className="cursor-pointer accent-[var(--accent)]"
                    title="Select all"
                  />
                </th>
                <th className="w-10 px-3 py-2 text-center">#</th>
                <th className="px-3 py-2">Title</th>
                <th className="hidden px-3 py-2 md:table-cell">Album</th>
                <th className="hidden px-3 py-2 lg:table-cell">Uploaded by</th>
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      toggleSel(t.id);
                    }}
                    className={`group border-b border-[var(--border)]/50 hover:bg-[var(--panel-2)] ${
                      selected.has(t.id) ? "bg-[var(--panel-2)]" : isCurrent ? "bg-[var(--panel-2)]" : ""
                    }`}
                  >
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSel(t.id)}
                        className="cursor-pointer accent-[var(--accent)]"
                      />
                    </td>
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
                      {t.uploader?.username ?? "—"}
                    </td>
                    <td className="hidden px-3 py-2 text-[var(--muted)] lg:table-cell">
                      {fmtDateAdded(t.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-3">
                        <LikeButton trackId={t.id} />
                        <AddToPlaylist trackId={t.id} track={t} onDeleted={() => load(q)} onEdited={() => load(q)} />
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
