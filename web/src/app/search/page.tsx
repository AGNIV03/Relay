"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, X, Clock, ListMusic, Mic2 } from "lucide-react";
import { searchAll } from "@/lib/api2";
import type { SearchResults } from "@/lib/types2";
import {
  addRecentSearch,
  clearRecentSearches,
  loadRecentSearches,
  removeRecentSearch,
} from "@/lib/prefs2";
import { TrackList } from "@/components/TrackList";
import { AlbumCard } from "@/components/AlbumCard";

type Tab = "all" | "songs" | "artists" | "albums" | "playlists";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "songs", label: "Songs" },
  { key: "artists", label: "Artists" },
  { key: "albums", label: "Albums" },
  { key: "playlists", label: "Playlists" },
];

/** In "All", each group shows a preview; its tab shows everything. */
const PREVIEW = { songs: 5, artists: 8, albums: 8, playlists: 8 };

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setRecent(loadRecentSearches()), []);

  // Debounced search; stale responses are dropped.
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let active = true;
    const t = setTimeout(() => {
      searchAll(query)
        .then((r) => {
          if (!active) return;
          setResults(r);
          setError(false);
        })
        .catch(() => active && setError(true))
        .finally(() => active && setLoading(false));
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [q]);

  /** Remember the query once the user acts on it (Enter or opening a result). */
  const remember = () => {
    if (q.trim()) setRecent(addRecentSearch(q));
  };

  const empty =
    results &&
    !results.tracks.length &&
    !results.artists.length &&
    !results.albums.length &&
    !results.playlists.length;

  const lim = (n: number) => (tab === "all" ? n : Infinity);
  const show = (t: Tab) => tab === "all" || tab === t;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Search</h1>

      <div className="relative mb-4 max-w-xl">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && remember()}
          autoFocus
          placeholder="Songs, artists, albums, playlists…"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] py-2 pl-9 pr-9 outline-none focus:border-[var(--accent)]"
        />
        {q && (
          <button
            onClick={() => {
              setQ("");
              inputRef.current?.focus();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white"
            title="Clear"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Recent searches (empty box) */}
      {!q.trim() && (
        <section className="max-w-xl">
          {recent.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Find songs, artists, albums and playlists.</p>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Recent searches</h2>
                <button
                  onClick={() => setRecent(clearRecentSearches())}
                  className="text-xs text-[var(--muted)] hover:text-white"
                >
                  Clear all
                </button>
              </div>
              <ul className="overflow-hidden rounded-xl border border-[var(--border)]">
                {recent.map((r) => (
                  <li
                    key={r}
                    className="group flex items-center gap-3 border-b border-[var(--border)]/50 px-3 py-2 text-sm last:border-b-0 hover:bg-[var(--panel-2)]"
                  >
                    <Clock size={14} className="shrink-0 text-[var(--muted)]" />
                    <button onClick={() => setQ(r)} className="min-w-0 flex-1 truncate text-left">
                      {r}
                    </button>
                    <button
                      onClick={() => setRecent(removeRecentSearch(r))}
                      className="text-[var(--muted)] opacity-0 transition hover:text-white group-hover:opacity-100"
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {q.trim() && (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-full px-3 py-1 text-sm transition ${
                  tab === t.key
                    ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                    : "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {error && !results && (
            <div className="text-sm text-red-400">Search failed. Check your connection.</div>
          )}
          {loading && !results && <div className="text-[var(--muted)]">Searching…</div>}
          {empty && <div className="text-[var(--muted)]">No results for “{q.trim()}”.</div>}

          {results && !empty && (
            <div className="space-y-8" onClickCapture={remember}>
              {show("songs") && results.tracks.length > 0 && (
                <Group
                  title="Songs"
                  more={tab === "all" && results.tracks.length > PREVIEW.songs}
                  onMore={() => setTab("songs")}
                >
                  <TrackList tracks={results.tracks.slice(0, lim(PREVIEW.songs))} />
                </Group>
              )}

              {show("artists") && results.artists.length > 0 && (
                <Group
                  title="Artists"
                  more={tab === "all" && results.artists.length > PREVIEW.artists}
                  onMore={() => setTab("artists")}
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                    {results.artists.slice(0, lim(PREVIEW.artists)).map((a) => (
                      <Link
                        key={a.id}
                        href={`/artists/${a.id}`}
                        className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 transition hover:bg-[var(--panel-2)]"
                      >
                        <Mic2 size={18} className="shrink-0 text-[var(--muted)]" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{a.name}</div>
                          <div className="text-xs text-[var(--muted)]">
                            {a._count?.albums ?? 0} albums · {a._count?.tracks ?? 0} tracks
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </Group>
              )}

              {show("albums") && results.albums.length > 0 && (
                <Group
                  title="Albums"
                  more={tab === "all" && results.albums.length > PREVIEW.albums}
                  onMore={() => setTab("albums")}
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {results.albums.slice(0, lim(PREVIEW.albums)).map((a) => (
                      <AlbumCard key={a.id} album={a} />
                    ))}
                  </div>
                </Group>
              )}

              {show("playlists") && results.playlists.length > 0 && (
                <Group
                  title="Playlists"
                  more={tab === "all" && results.playlists.length > PREVIEW.playlists}
                  onMore={() => setTab("playlists")}
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                    {results.playlists.slice(0, lim(PREVIEW.playlists)).map((p) => (
                      <Link
                        key={p.id}
                        href={`/playlists/${p.id}`}
                        className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 transition hover:bg-[var(--panel-2)]"
                      >
                        <ListMusic size={18} className="shrink-0 text-[var(--muted)]" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{p.name}</div>
                          <div className="truncate text-xs text-[var(--muted)]">
                            {p.ownerName} · {p.trackCount} {p.trackCount === 1 ? "song" : "songs"}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </Group>
              )}

              {tab !== "all" &&
                ((tab === "songs" && !results.tracks.length) ||
                  (tab === "artists" && !results.artists.length) ||
                  (tab === "albums" && !results.albums.length) ||
                  (tab === "playlists" && !results.playlists.length)) && (
                  <div className="text-[var(--muted)]">No {tab} match “{q.trim()}”.</div>
                )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Group({
  title,
  more,
  onMore,
  children,
}: {
  title: string;
  more: boolean;
  onMore: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        {more && (
          <button onClick={onMore} className="text-sm text-[var(--muted)] hover:text-white">
            See all
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
