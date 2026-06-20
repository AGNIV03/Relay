"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

const NAV = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/songs", label: "My Songs", icon: "🎵" },
  { href: "/artists", label: "Artists", icon: "🎤" },
  { href: "/search", label: "Search", icon: "🔍" },
  { href: "/playlists", label: "Playlists", icon: "📃" },
  { href: "/favorites", label: "Favorites", icon: "❤️" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="mb-6 px-2">
        <div className="text-xl font-bold tracking-tight">
          <span className="text-[var(--accent-2)]">♪</span> Stream
        </div>
        <div className="text-xs text-[var(--muted)]">self-hosted music</div>
      </div>

      <nav className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                active
                  ? "bg-[var(--panel-2)] text-white"
                  : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
        {user?.role === "ADMIN" && (
          <Link
            href="/admin"
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
              pathname.startsWith("/admin")
                ? "bg-[var(--panel-2)] text-white"
                : "text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
            }`}
          >
            <span>⚙️</span> Admin
          </Link>
        )}
      </nav>

      <div className="mt-auto border-t border-[var(--border)] pt-4">
        <div className="px-2 text-sm">{user?.username}</div>
        <div className="px-2 text-xs text-[var(--muted)]">{user?.role}</div>
        <button
          onClick={logout}
          className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
