"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, X } from "lucide-react";
import { tokens } from "@/lib/api";
import { authApi } from "@/lib/api2";
import { useAuth } from "@/context/AuthContext";

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

type CodeState = "idle" | "checking" | "valid" | "invalid" | "error";

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary for static prerendering.
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState(() => params.get("code") ?? "");
  const [codeState, setCodeState] = useState<CodeState>("idle");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) router.replace("/");
  }, [user, router]);

  // Live-validate the code (debounced; the check doesn't consume it).
  useEffect(() => {
    const c = code.trim();
    if (c.length < 4) {
      setCodeState("idle");
      return;
    }
    setCodeState("checking");
    let active = true;
    const t = setTimeout(() => {
      authApi
        .checkInvite(c)
        .then((r) => active && setCodeState(r.valid ? "valid" : "invalid"))
        .catch(() => active && setCodeState("error"));
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [code]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!code.trim()) return setError("Enter your invite code");
    if (!USERNAME_RE.test(username))
      return setError("Username must be 3 to 32 characters: letters, numbers, _ . -");
    if (password.length < 10) return setError("Password must be at least 10 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const data = await authApi.register(code.trim(), username, password);
      // Same token storage as login; a full navigation lets AuthProvider load the
      // session (and the player its media token) from scratch.
      tokens.set(data.accessToken, data.refreshToken);
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the account");
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none focus:border-[var(--accent)]";

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-8"
      >
        <div className="mb-6 text-center">
          <div className="flex items-center justify-center gap-2 text-2xl font-bold">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Relay" className="h-7 w-7" /> Relay
          </div>
          <div className="mt-1 text-sm text-[var(--muted)]">Create your account</div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <label className="mb-1 block text-sm text-[var(--muted)]">Invite code</label>
        <div className="relative mb-1">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoFocus={!code}
            spellCheck={false}
            autoComplete="off"
            className={`${inputCls} pr-9 font-mono tracking-wider`}
          />
          {codeState === "valid" && (
            <Check size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-400" />
          )}
          {codeState === "invalid" && (
            <X size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-red-400" />
          )}
        </div>
        <div className="mb-4 h-4 text-xs">
          {codeState === "checking" && <span className="text-[var(--muted)]">Checking…</span>}
          {codeState === "valid" && <span className="text-emerald-400">Invite code is valid</span>}
          {codeState === "invalid" && (
            <span className="text-red-400">This code is invalid, expired or already used</span>
          )}
          {codeState === "error" && (
            <span className="text-[var(--muted)]">Couldn&apos;t check the code right now</span>
          )}
        </div>

        <label className="mb-1 block text-sm text-[var(--muted)]">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus={!!code}
          autoComplete="username"
          className={`${inputCls} mb-4`}
        />

        <label className="mb-1 block text-sm text-[var(--muted)]">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="min 10 characters"
          autoComplete="new-password"
          className={`${inputCls} mb-4`}
        />

        <label className="mb-1 block text-sm text-[var(--muted)]">Confirm password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={`${inputCls} mb-6`}
        />

        <button
          type="submit"
          disabled={busy || codeState === "invalid"}
          className="w-full rounded-lg bg-[var(--accent)] py-2 font-medium text-[var(--accent-ink)] transition hover:bg-[var(--accent-2)] disabled:opacity-50"
        >
          {busy ? "Creating account…" : "Create account"}
        </button>

        <div className="mt-4 text-center text-sm text-[var(--muted)]">
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--accent)] hover:underline">
            Sign in
          </Link>
        </div>
      </form>
    </div>
  );
}
