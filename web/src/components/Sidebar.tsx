"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Home, Music2, Mic2, ListMusic, Settings, LogOut, ChevronDown, Plus, Heart } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import type { Playlist } from "@/lib/types";

const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/songs", label: "Songs", Icon: Music2 },
  { href: "/artists", label: "Artists", Icon: Mic2 },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [plOpen, setPlOpen] = useState(true);

  useEffect(() => {
    api.get<Playlist[]>("/api/playlists").then(setPlaylists).catch(() => {});
  }, [pathname]);

  const itemCls = (active: boolean) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
      active
        ? "bg-[var(--panel-2)] text-white"
        : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
    }`;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="mb-6 px-2">
        <div className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Music2 className="text-[var(--accent)]" size={22} /> Stream
        </div>
        <div className="text-xs text-[var(--muted)]">self-hosted music</div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {NAV.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className={itemCls(pathname === href)}>
            <Icon size={18} /> {label}
          </Link>
        ))}

        {/* Playlists with expandable dropdown */}
        <div className="mt-1">
          <div className={itemCls(pathname === "/playlists")}>
            <Link href="/playlists" className="flex flex-1 items-center gap-3">
              <ListMusic size={18} /> Playlists
            </Link>
            <button
              onClick={() => setPlOpen((o) => !o)}
              className="rounded p-0.5 hover:text-white"
              aria-label="Toggle playlists"
            >
              <ChevronDown
                size={16}
                className={`transition-transform ${plOpen ? "" : "-rotate-90"}`}
              />
            </button>
          </div>
          {plOpen && (
            <div className="ml-3 mt-0.5 flex flex-col border-l border-[var(--border)] pl-2">
              {/* Permanent, undeletable Liked Songs playlist */}
              <Link
                href="/liked"
                className={`flex items-center gap-2 truncate rounded px-2 py-1 text-sm transition ${
                  pathname === "/liked"
                    ? "text-[var(--accent)]"
                    : "text-[var(--muted)] hover:text-white"
                }`}
              >
                <Heart size={13} fill="currentColor" className="text-[var(--accent)]" /> Liked Songs
              </Link>
              {playlists.length === 0 && (
                <span className="px-2 py-1 text-xs text-[var(--muted)]">No playlists</span>
              )}
              {playlists.map((pl) => (
                <Link
                  key={pl.id}
                  href={`/playlists/${pl.id}`}
                  className={`truncate rounded px-2 py-1 text-sm transition ${
                    pathname === `/playlists/${pl.id}`
                      ? "text-[var(--accent)]"
                      : "text-[var(--muted)] hover:text-white"
                  }`}
                >
                  {pl.name}
                </Link>
              ))}
              <Link
                href="/playlists"
                className="mt-0.5 flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--muted)] hover:text-white"
              >
                <Plus size={13} /> New playlist
              </Link>
            </div>
          )}
        </div>

        {user?.role === "ADMIN" && (
          <Link href="/admin" className={`mt-1 ${itemCls(pathname.startsWith("/admin"))}`}>
            <Settings size={18} /> Admin
          </Link>
        )}
      </nav>

      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <div className="px-2 text-sm">{user?.username}</div>
        <div className="px-2 text-xs text-[var(--muted)]">{user?.role}</div>
        <button
          onClick={logout}
          className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
        >
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );
}
