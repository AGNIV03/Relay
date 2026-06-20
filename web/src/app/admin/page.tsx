"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { fmtBytes, fmtDurationLong } from "@/lib/format";
import type { Stats, ScanStatus, User } from "@/lib/types";

export default function AdminPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [users, setUsers] = useState<User[]>([]);

  const loadStats = useCallback(() => api.get<Stats>("/api/admin/stats").then(setStats), []);
  const loadScan = useCallback(() => api.get<ScanStatus>("/api/admin/scan").then(setScan), []);
  const loadUsers = useCallback(() => api.get<User[]>("/api/admin/users").then(setUsers), []);

  useEffect(() => {
    loadStats().catch(() => {});
    loadScan().catch(() => {});
    loadUsers().catch(() => {});
  }, [loadStats, loadScan, loadUsers]);

  // Poll while a scan is running.
  useEffect(() => {
    if (!scan?.scanning) return;
    const t = setInterval(() => {
      loadScan().then(() => loadStats()).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [scan?.scanning, loadScan, loadStats]);

  if (user?.role !== "ADMIN") {
    return <div className="text-[var(--muted)]">Admins only.</div>;
  }

  async function startScan() {
    await api.post("/api/admin/scan").catch(() => {});
    loadScan();
  }

  return (
    <div className="max-w-4xl">
      <h1 className="mb-6 text-2xl font-bold">⚙️ Admin</h1>

      {/* Stats */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Library</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Tracks" value={stats?.tracks ?? "—"} />
          <Stat label="Albums" value={stats?.albums ?? "—"} />
          <Stat label="Artists" value={stats?.artists ?? "—"} />
          <Stat label="Users" value={stats?.users ?? "—"} />
          <Stat
            label="Total time"
            value={stats ? fmtDurationLong(stats.totalDurationSec) : "—"}
          />
          <Stat label="Total size" value={stats ? fmtBytes(stats.totalSizeBytes) : "—"} />
          <Stat label="Playlists" value={stats?.playlists ?? "—"} />
        </div>
      </section>

      {/* Scan */}
      <section className="mb-8 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Library scan</h2>
            <p className="text-sm text-[var(--muted)]">
              Re-scans your music folder for new, changed, and removed files.
            </p>
          </div>
          <button
            onClick={startScan}
            disabled={scan?.scanning}
            className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--accent-2)] disabled:opacity-50"
          >
            {scan?.scanning ? "Scanning…" : "Scan now"}
          </button>
        </div>
        {scan?.lastResult && (
          <div className="mt-3 text-sm text-[var(--muted)]">
            Last scan: {scan.lastResult.scanned} scanned · {scan.lastResult.added} added ·{" "}
            {scan.lastResult.updated} updated · {scan.lastResult.removed} removed ·{" "}
            {scan.lastResult.errors} errors
          </div>
        )}
      </section>

      {/* Users */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Users</h2>
        <CreateUser onCreated={loadUsers} />
        <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-2">Username</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border)]/50">
                  <td className="px-4 py-2 font-medium">{u.username}</td>
                  <td className="px-4 py-2">
                    {u.id === user.id ? (
                      <span className="rounded px-2 py-0.5 text-xs bg-[var(--accent)]/20 text-[var(--accent)]">
                        {u.role} (you)
                      </span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={async (e) => {
                          await api
                            .patch(`/api/admin/users/${u.id}/role`, { role: e.target.value })
                            .catch(() => {});
                          loadUsers();
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
                      >
                        <option value="USER">USER</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[var(--muted)]">
                    {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {u.id !== user.id && (
                      <button
                        onClick={async () => {
                          if (confirm(`Delete user ${u.username}?`)) {
                            await api.del(`/api/admin/users/${u.id}`);
                            loadUsers();
                          }
                        }}
                        className="text-[var(--muted)] hover:text-red-400"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
    </div>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.post("/api/admin/users", { username, password, role });
      setUsername("");
      setPassword("");
      setRole("USER");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 outline-none focus:border-[var(--accent)]"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 outline-none focus:border-[var(--accent)]"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "USER" | "ADMIN")}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 outline-none focus:border-[var(--accent)]"
        >
          <option value="USER">USER</option>
          <option value="ADMIN">ADMIN</option>
        </select>
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-2)] disabled:opacity-50"
      >
        Add user
      </button>
      {error && <div className="w-full text-sm text-red-400">{error}</div>}
    </form>
  );
}
