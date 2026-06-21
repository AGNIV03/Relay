"use client";

import { useState } from "react";
import { LogOut, KeyRound, User } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next.length < 6) return setMsg({ ok: false, text: "New password must be at least 6 characters" });
    if (next !== confirm) return setMsg({ ok: false, text: "New passwords don't match" });
    setBusy(true);
    try {
      await api.post("/api/auth/change-password", { currentPassword: current, newPassword: next });
      setMsg({ ok: true, text: "Password changed" });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not change password" });
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 outline-none focus:border-[var(--accent)]";

  return (
    <div className="mx-auto max-w-lg">
      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] text-3xl font-bold text-[var(--accent-ink)]">
          {user?.username.charAt(0).toUpperCase() ?? <User size={28} />}
        </div>
        <div>
          <h1 className="text-2xl font-bold">{user?.username}</h1>
          <div className="text-sm uppercase tracking-wide text-[var(--muted)]">{user?.role}</div>
        </div>
      </div>

      {/* Change password */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <KeyRound size={16} /> Change password
        </h2>
        <form onSubmit={changePassword} className="space-y-3">
          <input
            type="password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={inputCls}
            autoComplete="current-password"
          />
          <input
            type="password"
            placeholder="New password (min 6)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={inputCls}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputCls}
            autoComplete="new-password"
          />
          {msg && (
            <div className={`text-sm ${msg.ok ? "text-[var(--accent)]" : "text-red-400"}`}>
              {msg.text}
            </div>
          )}
          <button
            type="submit"
            disabled={busy || !current || !next}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-50"
          >
            {busy ? "Saving…" : "Update password"}
          </button>
        </form>
      </section>

      {/* Sign out */}
      <button
        onClick={logout}
        className="mt-6 flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] transition hover:bg-[var(--panel-2)] hover:text-white"
      >
        <LogOut size={16} /> Sign out
      </button>
    </div>
  );
}
