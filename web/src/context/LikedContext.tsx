"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "./AuthContext";

interface LikedState {
  likedIds: Set<string>;
  isLiked: (trackId: string) => boolean;
  toggleLike: (trackId: string) => Promise<void>;
  /** re-fetch liked ids from the server (e.g. after uploading, which auto-likes) */
  refresh: () => Promise<void>;
  /** bump on every change so views (e.g. the Liked Songs page) can refetch */
  version: number;
}

const LikedContext = createContext<LikedState | null>(null);

export function LikedProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!user) {
      setLikedIds(new Set());
      return;
    }
    api
      .get<string[]>("/api/library/liked/ids")
      .then((ids) => setLikedIds(new Set(ids)))
      .catch(() => {});
  }, [user]);

  const isLiked = useCallback((id: string) => likedIds.has(id), [likedIds]);

  const refresh = useCallback(async () => {
    try {
      const ids = await api.get<string[]>("/api/library/liked/ids");
      setLikedIds(new Set(ids));
      setVersion((v) => v + 1);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleLike = useCallback(
    async (trackId: string) => {
      const liked = likedIds.has(trackId);
      // Optimistic update.
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (liked) next.delete(trackId);
        else next.add(trackId);
        return next;
      });
      setVersion((v) => v + 1);
      try {
        if (liked) await api.del(`/api/library/like/${trackId}`);
        else await api.post("/api/library/like", { trackId });
      } catch {
        // Revert on failure.
        setLikedIds((prev) => {
          const next = new Set(prev);
          if (liked) next.add(trackId);
          else next.delete(trackId);
          return next;
        });
      }
    },
    [likedIds],
  );

  return (
    <LikedContext.Provider value={{ likedIds, isLiked, toggleLike, refresh, version }}>
      {children}
    </LikedContext.Provider>
  );
}

export function useLiked() {
  const ctx = useContext(LikedContext);
  if (!ctx) throw new Error("useLiked must be used within LikedProvider");
  return ctx;
}
