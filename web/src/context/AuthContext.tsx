"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, tokens } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (tokens.access) {
        try {
          setUser(await api.get<User>("/api/auth/me"));
        } catch {
          tokens.clear();
        }
      }
      setLoading(false);
    })();
  }, []);

  async function login(username: string, password: string) {
    const data = await api.post<{ accessToken: string; refreshToken: string; user: User }>(
      "/api/auth/login",
      { username, password },
    );
    tokens.set(data.accessToken, data.refreshToken);
    setUser(data.user);
  }

  function logout() {
    tokens.clear();
    setUser(null);
    window.location.href = "/login";
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
