"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  LogOut,
  KeyRound,
  User,
  ShieldCheck,
  MonitorSmartphone,
  SlidersHorizontal,
  ChevronRight,
} from "lucide-react";
import { api, tokens } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { Privacy } from "@/lib/types";
import { RewindProfileEntry } from "@/components/rewind";

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);

  // Revoke every token for this account on every device (including this one),
  // then sign out here too.
  async function signOutEverywhere() {
    setAllBusy(true);
    setAllError(null);
    try {
      await api.post("/api/auth/logout-all");
    } catch (err) {
      setAllBusy(false);
      setAllError(
        `Couldn't sign out everywhere: ${err instanceof Error ? err.message : "network error"}`,
      );
      return;
    }
    logout();
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next.length < 10) return setMsg({ ok: false, text: "New password must be at least 10 characters" });
    if (next !== confirm) return setMsg({ ok: false, text: "New passwords don't match" });
    setBusy(true);
    try {
      // The server revokes every session on a password change and returns a fresh
      // token pair for this browser so it stays signed in.
      const r = await api.post<{ accessToken?: string; refreshToken?: string }>(
        "/api/auth/change-password",
        { currentPassword: current, newPassword: next },
      );
      if (r?.accessToken) tokens.set(r.accessToken, r.refreshToken);
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

      {/* Last year's Rewind lives here from Jan 8 until the next one is on Home. */}
      <RewindProfileEntry className="mb-6" />

      <Link
        href="/settings"
        className="mb-6 flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 transition hover:bg-[var(--panel-2)]"
      >
        <SlidersHorizontal size={18} className="text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Settings</div>
          <div className="text-xs text-[var(--muted)]">Autoplay, volume normalization, crossfade, scrobbling</div>
        </div>
        <ChevronRight size={18} className="text-[var(--muted)]" />
      </Link>

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
            placeholder="New password (min 10)"
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

      <PrivacySettings />

      {/* Sign out */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={logout}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] transition hover:bg-[var(--panel-2)] hover:text-white"
        >
          <LogOut size={16} /> Sign out
        </button>
        <button
          onClick={() => {
            setAllError(null);
            setConfirmAll(true);
          }}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-red-400 transition hover:bg-[var(--panel-2)]"
        >
          <MonitorSmartphone size={16} /> Sign out of all devices
        </button>
      </div>

      {confirmAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !allBusy && setConfirmAll(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl"
          >
            <h2 className="text-base font-semibold">Sign out of all devices?</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Every phone, computer and browser signed in to this account will be signed out,
              including this one.
            </p>
            {allError && <p className="mt-3 text-sm text-red-400">{allError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmAll(false)}
                disabled={allBusy}
                className="rounded-lg px-4 py-2 text-sm text-[var(--muted)] transition hover:bg-[var(--panel-2)] hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={signOutEverywhere}
                disabled={allBusy}
                className="rounded-lg bg-red-500/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
              >
                {allBusy ? "Signing out…" : "Sign out everywhere"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Privacy toggles: whether others can see what you're playing (plus your recent
 *  plays and likes), and whether they can listen along with you. */
function PrivacySettings() {
  const [p, setP] = useState<Privacy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Privacy>("/api/social/privacy")
      .then(setP)
      .catch(() => setError("Couldn't load your privacy settings"));
  }, []);

  async function set(patch: Partial<Privacy>) {
    setSaving(true);
    setError(null);
    try {
      setP(await api.patch<Privacy>("/api/social/privacy", patch));
    } catch {
      setError("Couldn't save. Check your connection.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <ShieldCheck size={16} /> Privacy &amp; sharing
      </h2>
      {!p && !error && <div className="text-sm text-[var(--muted)]">Loading…</div>}
      {p && (
        <div className="space-y-4">
          <SettingRow
            title="Share my listening activity"
            subtitle="Others on this server can see what you are playing, your recent plays and likes."
            on={p.shareActivity}
            disabled={saving}
            onToggle={() => set({ shareActivity: !p.shareActivity })}
          />
          {/* Needs sharing on: shown off (and locked) while sharing is off. */}
          <SettingRow
            title="Allow listen along"
            subtitle={
              p.shareActivity
                ? "Others can follow along with your music in sync."
                : "Needs activity sharing turned on."
            }
            on={p.allowListenAlong && p.shareActivity}
            disabled={saving || !p.shareActivity}
            dim={!p.shareActivity}
            onToggle={() => set({ allowListenAlong: !p.allowListenAlong })}
          />
        </div>
      )}
      {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
    </section>
  );
}

function SettingRow({
  title,
  subtitle,
  on,
  disabled,
  dim,
  onToggle,
}: {
  title: string;
  subtitle: string;
  on: boolean;
  disabled?: boolean;
  dim?: boolean; // unavailable (not just saving)
  onToggle: () => void;
}) {
  return (
    <div className={`flex items-center gap-4 ${dim ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-[var(--muted)]">{subtitle}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        disabled={disabled}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed ${
          on ? "bg-[var(--accent)]" : "bg-[var(--panel-2)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
