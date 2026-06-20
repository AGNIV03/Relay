"use client";

import Link from "next/link";
import { useState } from "react";
import { albumCoverUrl } from "@/lib/api";
import type { Album } from "@/lib/types";

export function AlbumCard({ album }: { album: Album }) {
  const [err, setErr] = useState(false);
  return (
    <Link
      href={`/albums/${album.id}`}
      className="group rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 transition hover:bg-[var(--panel-2)]"
    >
      <div className="mb-3 aspect-square overflow-hidden rounded-lg bg-[var(--panel-2)]">
        {!err ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={albumCoverUrl(album.id)}
            alt={album.title}
            className="h-full w-full object-cover transition group-hover:scale-[1.03]"
            onError={() => setErr(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-4xl text-[var(--muted)]">
            💿
          </div>
        )}
      </div>
      <div className="truncate text-sm font-medium">{album.title}</div>
      <div className="truncate text-xs text-[var(--muted)]">
        {album.artist?.name}
        {album.year ? ` · ${album.year}` : ""}
      </div>
    </Link>
  );
}
