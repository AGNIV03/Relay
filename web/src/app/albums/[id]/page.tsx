"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Play, Disc3 } from "lucide-react";
import { api, albumCoverUrl } from "@/lib/api";
import { usePlayer } from "@/context/PlayerContext";
import { TrackList } from "@/components/TrackList";
import { fmtDurationLong } from "@/lib/format";
import type { Album } from "@/lib/types";

export default function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  const [album, setAlbum] = useState<Album | null>(null);
  const [err, setErr] = useState(false);
  const player = usePlayer();

  useEffect(() => {
    api.get<Album>(`/api/library/albums/${id}`).then(setAlbum).catch(() => {});
  }, [id]);

  if (!album) return <div className="text-[var(--muted)]">Loading…</div>;

  const tracks = album.tracks ?? [];
  const totalDur = tracks.reduce((s, t) => s + t.duration, 0);

  return (
    <div>
      <div className="mb-6 flex flex-col items-center gap-5 sm:flex-row sm:items-end">
        <div className="flex h-44 w-44 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--panel-2)]">
          {!err ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={albumCoverUrl(album.id)}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setErr(true)}
            />
          ) : (
            <Disc3 size={56} className="text-[var(--muted)]" />
          )}
        </div>
        <div className="text-center sm:text-left">
          <div className="text-xs uppercase text-[var(--muted)]">Album</div>
          <h1 className="text-3xl font-bold">{album.title}</h1>
          <div className="mt-1 text-sm text-[var(--muted)]">
            <Link href={`/artists/${album.artist?.id}`} className="hover:text-white">
              {album.artist?.name}
            </Link>
            {album.year ? ` · ${album.year}` : ""} · {tracks.length} tracks ·{" "}
            {fmtDurationLong(totalDur)}
          </div>
          <button
            onClick={() => player.playQueue(tracks, 0)}
            className="mt-4 flex items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110"
          >
            <Play size={16} /> Play
          </button>
        </div>
      </div>

      <TrackList tracks={tracks} showAlbum={false} showArtist={false} />
    </div>
  );
}
