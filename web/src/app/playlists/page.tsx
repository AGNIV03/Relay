"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/api";
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
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {playlists.map((pl) => (
            <div
              key={pl.id}
              className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 hover:bg-[var(--panel-2)]"
            >
              <Link href={`/playlists/${pl.id}`} className="min-w-0 flex-1">
                <div className="truncate font-medium">{pl.name}</div>
                <div className="text-xs text-[var(--muted)]">{pl._count?.tracks ?? 0} tracks</div>
              </Link>
              <button
                onClick={() => remove(pl.id)}
                className="ml-2 text-[var(--muted)] hover:text-red-400"
                title="Delete"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
