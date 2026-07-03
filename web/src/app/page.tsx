"use client";

import { useEffect, useState } from "react";
import { Clock, Music2, Disc3, ListMusic, Sparkles, Star } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { AlbumCard } from "@/components/AlbumCard";
import { TrackCards } from "@/components/TrackCards";
import { PlaylistCards, RecentCards } from "@/components/HomeRows";
import type { Album, PlaylistRef, RecentItem, Track, WrappedStats } from "@/lib/types";

export default function HomePage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [most, setMost] = useState<Track[]>([]);
  const [added, setAdded] = useState<Album[]>([]);
  const [curated, setCurated] = useState<PlaylistRef[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get<WrappedStats>("/api/library/stats/me").then(setStats),
      api.get<RecentItem[]>("/api/library/recently-played?grouped=1").then(setRecent),
      api.get<Track[]>("/api/library/most-played").then(setMost),
      api.get<Album[]>("/api/library/albums?recent=1").then(setAdded),
      api.get<PlaylistRef[]>("/api/playlists/public").then(setCurated),
    ]).finally(() => setLoading(false));
  }, []);

  const hasActivity = (stats?.totalPlays ?? 0) > 0;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">
          Welcome back, <span className="text-[var(--accent)]">{user?.username}</span>
        </h1>
        <p className="text-sm text-[var(--muted)]">Here&apos;s your music at a glance.</p>
      </div>

      {/* Wrapped-style listening stats */}
      {hasActivity && stats && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <Sparkles size={18} className="text-[var(--accent)]" /> Your listening
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[var(--border)] bg-gradient-to-br from-[var(--panel-2)] to-[var(--panel)] p-5">
              <div className="grid grid-cols-3 gap-3 text-center">
                <Stat big value={stats.totalPlays} label="plays" />
                <Stat big value={stats.totalMinutes} label="minutes" />
                <Stat big value={stats.distinctTracks} label="songs" />
              </div>
            </div>
            <TopList title="Top artists" items={stats.topArtists.map((a) => `${a.name}`)} />
            <TopList
              title="Top songs"
              items={stats.topTracks.map((t) => `${t.title} — ${t.artist}`)}
            />
          </div>
          {stats.topGenres.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {stats.topGenres.map((g) => (
                <span
                  key={g.name}
                  className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)]"
                >
                  {g.name} · {g.count}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {curated.length > 0 && (
        <Section icon={<Star size={18} />} title="Curated playlists">
          <PlaylistCards playlists={curated} />
        </Section>
      )}

      {recent.length > 0 && (
        <Section icon={<Clock size={18} />} title="Recently played">
          <RecentCards items={recent} />
        </Section>
      )}

      {most.length > 0 && (
        <Section icon={<Music2 size={18} />} title="Most played">
          <TrackCards tracks={most} />
        </Section>
      )}

      <Section icon={<Disc3 size={18} />} title="Recently added">
        {loading ? (
          <div className="text-[var(--muted)]">Loading…</div>
        ) : added.length === 0 ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-8 text-center text-[var(--muted)]">
            Your library is empty. Add songs on the Songs page.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {added.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
        )}
      </Section>

      {!hasActivity && !loading && (
        <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <ListMusic size={16} /> Play some music and your stats, recents, and top tracks will show up
          here.
        </p>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <span className="text-[var(--accent)]">{icon}</span> {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ value, label, big }: { value: number | string; label: string; big?: boolean }) {
  return (
    <div>
      <div className={`font-bold text-[var(--accent)] ${big ? "text-2xl" : "text-xl"}`}>{value}</div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
    </div>
  );
}

function TopList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">{title}</div>
      <ol className="space-y-1.5">
        {items.length === 0 && <li className="text-sm text-[var(--muted)]">—</li>}
        {items.slice(0, 5).map((s, i) => (
          <li key={i} className="flex items-center gap-2 truncate text-sm">
            <span className="w-4 text-[var(--accent)]">{i + 1}</span>
            <span className="truncate">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
