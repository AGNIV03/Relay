"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login";

  useEffect(() => {
    if (!loading && !user && !isLogin) router.replace("/login");
  }, [loading, user, isLogin, router]);

  if (isLogin) return <>{children}</>;

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center text-[var(--muted)]">Loading…</div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">{children}</main>
      </div>
      <PlayerBar />
    </div>
  );
}
