"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trash2, Music } from "lucide-react";
import { api, playlistCoverUrl } from "@/lib/api";
import type { Playlist } from "@/lib/types";

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);

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

      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : playlists.length === 0 ? (
        <div className="text-[var(--muted)]">No playlists yet. Create one above.</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {playlists.map((pl) => (
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
      )}
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
