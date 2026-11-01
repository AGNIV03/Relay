"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trash2, Music, Search } from "lucide-react";
import { api, playlistCoverUrl } from "@/lib/api";
import { pickSort, seededShuffle, type SortState } from "@/lib/trackSort";
import { SortMenu } from "@/components/SortMenu";
import type { Playlist } from "@/lib/types";

type PlOrder = "shuffle" | "name" | "songs";
const PL_SORTS: { key: PlOrder; label: string }[] = [
  { key: "shuffle", label: "Shuffle" },
  { key: "name", label: "Name" },
  { key: "songs", label: "Most songs" },
];

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  // Default order is random. A per-visit seed keeps it stable across reloads
  // (create/delete); picking "Shuffle" in the sort menu reshuffles.
  const [sort, setSort] = useState<SortState<PlOrder>>({ order: "shuffle", asc: true });
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 32));

  function onPickSort(o: PlOrder) {
    if (o === "shuffle") {
      setSort({ order: "shuffle", asc: true });
      setSeed(Math.floor(Math.random() * 2 ** 32));
    } else {
      setSort((s) => pickSort(s, o));
    }
  }

  function ordered(list: Playlist[]): Playlist[] {
    if (sort.order === "shuffle") return seededShuffle(list, seed);
    const l = [...list].sort((a, b) =>
      sort.order === "name"
        ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        : (b._count?.tracks ?? 0) - (a._count?.tracks ?? 0), // most first
    );
    return sort.asc ? l : l.reverse();
  }

  function load() {
    api
      .get<Playlist[]>("/api/playlists")
      .then(setPlaylists)
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.post("/api/playlists", { name: name.trim() });
    setName("");
    load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this playlist?")) return;
    await api.del(`/api/playlists/${id}`);
    load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Playlists</h1>

      <form onSubmit={create} className="mb-6 flex max-w-md gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New playlist name"
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110"
        >
          Create
        </button>
      </form>

      <div className="mb-6 flex items-center gap-3">
        <div className="relative max-w-md flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search playlists…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] py-2 pl-9 pr-3 outline-none focus:border-[var(--accent)]"
          />
        </div>
        <SortMenu
          options={PL_SORTS}
          order={sort.order}
          asc={sort.asc}
          onPick={onPickSort}
          shuffleKey="shuffle"
          align="left"
        />
      </div>

      {(() => {
        const shown = ordered(
          q.trim()
            ? playlists.filter((pl) => pl.name.toLowerCase().includes(q.trim().toLowerCase()))
            : playlists,
        );
        return loading ? (
          <div className="text-[var(--muted)]">Loading…</div>
        ) : playlists.length === 0 ? (
          <div className="text-[var(--muted)]">No playlists yet. Create one above.</div>
        ) : shown.length === 0 ? (
          <div className="text-[var(--muted)]">No playlists match “{q}”.</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {shown.map((pl) => (
            <div key={pl.id} className="group relative">
              <Link href={`/playlists/${pl.id}`} className="block">
                <div className="relative mb-2 aspect-square overflow-hidden rounded-xl bg-[var(--panel-2)] shadow-lg">
                  <PlaylistCover id={pl.id} />
                </div>
                <div className="truncate text-sm font-medium">{pl.name}</div>
                <div className="text-xs text-[var(--muted)]">{pl._count?.tracks ?? 0} songs</div>
              </Link>
              <button
                onClick={() => remove(pl.id)}
                className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                title="Delete"
              >
                <Trash2 size={15} />
              </button>
            </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function PlaylistCover({ id }: { id: string }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Music size={40} className="text-[var(--muted)]" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={playlistCoverUrl(id)}
      alt=""
      className="h-full w-full object-cover"
      onError={() => setErr(true)}
    />
  );
}
