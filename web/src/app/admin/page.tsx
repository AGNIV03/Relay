"use client";

import { useEffect, useState, useCallback } from "react";
import { Copy, Link2, Check, Ban, HardDrive, Activity, Tags, Ticket, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { adminApi } from "@/lib/api2";
import { useAuth } from "@/context/AuthContext";
import { fmtBytes, fmtDurationLong } from "@/lib/format";
import type { Stats, ScanStatus, User, Role } from "@/lib/types";
import type { AdminDashboard, InviteCode } from "@/lib/types2";

/** "5m ago" style relative time. */
function fmtAgo(iso?: string | null): string {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "Never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const fmtNum = (n: number | undefined) => (n == null ? "–" : n.toLocaleString());

/** One row of the users table: dashboard data when available, else the basic list. */
interface UserRow {
  id: string;
  username: string;
  role: Role;
  createdAt?: string;
  lastSeenAt?: string | null;
  online?: boolean;
  plays7d?: number;
  uploads?: number;
}

export default function AdminPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [dash, setDash] = useState<AdminDashboard | null>(null);
  const [dashErr, setDashErr] = useState(false);
  const [legacyUsers, setLegacyUsers] = useState<User[]>([]);

  const loadStats = useCallback(() => api.get<Stats>("/api/admin/stats").then(setStats), []);
  const loadScan = useCallback(() => api.get<ScanStatus>("/api/admin/scan").then(setScan), []);
  const loadDash = useCallback(
    () =>
      adminApi
        .dashboard()
        .then((d) => {
          setDash(d);
          setDashErr(false);
        })
        .catch(() => {
          // Older server without the dashboard: fall back to the plain user list.
          setDashErr(true);
          return api.get<User[]>("/api/admin/users").then(setLegacyUsers);
        }),
    [],
  );

  useEffect(() => {
    loadStats().catch(() => {});
    loadScan().catch(() => {});
    loadDash().catch(() => {});
  }, [loadStats, loadScan, loadDash]);

  // Refresh the dashboard (online dots, plays) every 30s while open.
  useEffect(() => {
    const t = setInterval(() => loadDash().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [loadDash]);

  // Poll while a scan is running.
  useEffect(() => {
    if (!scan?.scanning) return;
    const t = setInterval(() => {
      loadScan()
        .then(() => loadStats())
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [scan?.scanning, loadScan, loadStats]);

  // A scan just finished: pick up the new counts.
  const [wasScanning, setWasScanning] = useState(false);
  useEffect(() => {
    if (scan?.scanning) setWasScanning(true);
    else if (wasScanning) {
      setWasScanning(false);
      loadDash().catch(() => {});
    }
  }, [scan?.scanning, wasScanning, loadDash]);

  if (user?.role !== "ADMIN") {
    return <div className="text-[var(--muted)]">Admins only.</div>;
  }

  async function startScan() {
    await api.post("/api/admin/scan").catch(() => {});
    loadScan();
  }

  const reloadUsers = () => loadDash().catch(() => {});
  const users: UserRow[] = dash?.users ?? legacyUsers;
  const scanning = scan?.scanning ?? dash?.scan.running ?? false;
  const lastScan = scan?.lastResult ?? dash?.scan.lastResult ?? null;
  const st = dash?.storage;
  const diskUsed = st ? Math.max(0, st.diskTotalBytes - st.diskFreeBytes) : 0;
  const diskPct = st && st.diskTotalBytes > 0 ? Math.min(100, (diskUsed / st.diskTotalBytes) * 100) : 0;

  return (
    <div className="max-w-5xl">
      <h1 className="mb-6 text-2xl font-bold">⚙️ Admin</h1>

      {dashErr && (
        <div className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--muted)]">
          The full dashboard isn&apos;t available on this server version. Showing basic stats.
        </div>
      )}

      {/* Library + activity */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Library</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Tracks" value={fmtNum(dash?.counts.tracks ?? stats?.tracks)} />
          <Stat label="Albums" value={fmtNum(dash?.counts.albums ?? stats?.albums)} />
          <Stat label="Artists" value={fmtNum(dash?.counts.artists ?? stats?.artists)} />
          <Stat label="Users" value={fmtNum(dash?.counts.users ?? stats?.users)} />
          <Stat label="Playlists" value={fmtNum(dash?.counts.playlists ?? stats?.playlists)} />
          <Stat
            label="Total time"
            value={stats ? fmtDurationLong(stats.totalDurationSec) : "–"}
          />
          <Stat label="Total size" value={stats ? fmtBytes(stats.totalSizeBytes) : "–"} />
          {dash && <Stat label="Active invites" value={fmtNum(dash.invites.active)} />}
        </div>
      </section>

      {dash && (
        <section className="mb-8 grid gap-3 md:grid-cols-2">
          {/* Storage */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <HardDrive size={18} /> Storage
            </h2>
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-[var(--muted)]">Disk</span>
              <span className="tabular-nums">
                {fmtBytes(diskUsed)} used of {fmtBytes(dash.storage.diskTotalBytes)}
              </span>
            </div>
            <div className="mb-1 h-2 overflow-hidden rounded-full bg-[var(--panel-2)]">
              <div
                className={`h-full rounded-full ${diskPct > 90 ? "bg-red-400" : "bg-[var(--accent)]"}`}
                style={{ width: `${diskPct}%` }}
              />
            </div>
            <div className="mb-4 text-xs text-[var(--muted)]">
              {fmtBytes(dash.storage.diskFreeBytes)} free
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-[var(--muted)]">Music</div>
                <div className="font-semibold tabular-nums">{fmtBytes(dash.storage.musicBytes)}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--muted)]">Covers</div>
                <div className="font-semibold tabular-nums">{fmtBytes(dash.storage.coversBytes)}</div>
              </div>
            </div>
          </div>

          {/* Listening activity */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <Activity size={18} /> Listening
            </h2>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-2xl font-bold tabular-nums">{fmtNum(dash.counts.plays24h)}</div>
                <div className="text-xs text-[var(--muted)]">Plays, 24h</div>
              </div>
              <div>
                <div className="text-2xl font-bold tabular-nums">{fmtNum(dash.counts.plays7d)}</div>
                <div className="text-xs text-[var(--muted)]">Plays, 7 days</div>
              </div>
              <div>
                <div className="text-2xl font-bold tabular-nums">
                  {fmtNum(Math.round(dash.counts.totalMinutes))}
                </div>
                <div className="text-xs text-[var(--muted)]">Minutes listened</div>
              </div>
            </div>
            <div className="mt-5 flex items-start gap-2 text-sm">
              <Tags size={16} className="mt-0.5 shrink-0 text-[var(--muted)]" />
              {dash.autotag.enabled ? (
                <span>
                  Auto-tagging is <span className="text-emerald-400">on</span>. New uploads get
                  missing tags filled in automatically.
                </span>
              ) : (
                <span className="text-[var(--muted)]">
                  Auto-tagging is off. Enable it in the server&apos;s .env to fill in missing tags on
                  upload.
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Scan */}
      <section className="mb-8 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Library scan</h2>
            <p className="text-sm text-[var(--muted)]">
              Re-scans your music folder for new, changed, and removed files.
            </p>
          </div>
          <button
            onClick={startScan}
            disabled={scanning}
            className="shrink-0 rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan now"}
          </button>
        </div>
        {lastScan && (
          <div className="mt-3 text-sm text-[var(--muted)]">
            Last scan: {lastScan.scanned} scanned · {lastScan.added} added · {lastScan.updated}{" "}
            updated · {lastScan.removed} removed · {lastScan.errors} errors
          </div>
        )}
      </section>

      {/* Users */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Users</h2>
        <CreateUser onCreated={reloadUsers} />
        <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-2">Username</th>
                <th className="px-4 py-2">Role</th>
                {dash && <th className="px-4 py-2">Last seen</th>}
                {dash && <th className="px-4 py-2 text-right">Plays 7d</th>}
                {dash && <th className="px-4 py-2 text-right">Uploads</th>}
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border)]/50">
                  <td className="px-4 py-2 font-medium">
                    <span className="flex items-center gap-2">
                      {dash && (
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            u.online ? "bg-emerald-400" : "bg-[var(--border)]"
                          }`}
                          title={u.online ? "Online" : "Offline"}
                        />
                      )}
                      {u.username}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {u.id === user.id ? (
                      <span className="rounded bg-[var(--accent)]/20 px-2 py-0.5 text-xs text-[var(--accent)]">
                        {u.role} (you)
                      </span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={async (e) => {
                          await api
                            .patch(`/api/admin/users/${u.id}/role`, { role: e.target.value })
                            .catch(() => {});
                          reloadUsers();
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
                      >
                        <option value="USER">USER</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    )}
                  </td>
                  {dash && (
                    <td className="px-4 py-2 text-[var(--muted)]">
                      {u.online ? <span className="text-emerald-400">Online</span> : fmtAgo(u.lastSeenAt)}
                    </td>
                  )}
                  {dash && <td className="px-4 py-2 text-right tabular-nums">{fmtNum(u.plays7d)}</td>}
                  {dash && <td className="px-4 py-2 text-right tabular-nums">{fmtNum(u.uploads)}</td>}
                  <td className="px-4 py-2 text-[var(--muted)]">
                    {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "–"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {u.id !== user.id && (
                      <button
                        onClick={async () => {
                          if (confirm(`Delete user ${u.username}?`)) {
                            await api.del(`/api/admin/users/${u.id}`).catch(() => {});
                            reloadUsers();
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

      {/* Invites */}
      {!dashErr && <Invites onChanged={reloadUsers} />}

      {/* Ingest rejections */}
      {dash && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <TriangleAlert size={18} /> Recent rejected files
          </h2>
          {dash.rejections.length === 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-[var(--muted)]">
              No rejected files. Everything uploaded or scanned recently was playable.
            </div>
          ) : (
            <div className="max-h-[420px] overflow-auto rounded-xl border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--bg)] text-left text-xs uppercase text-[var(--muted)]">
                  <tr className="border-b border-[var(--border)]">
                    <th className="px-4 py-2">File</th>
                    <th className="px-4 py-2">Reason</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">User</th>
                    <th className="px-4 py-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {dash.rejections.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--border)]/50">
                      <td className="max-w-[240px] truncate px-4 py-2 font-medium" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-4 py-2 text-[var(--muted)]">{r.reason}</td>
                      <td className="px-4 py-2">
                        <span className="rounded bg-[var(--panel-2)] px-2 py-0.5 text-xs capitalize">
                          {r.source}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[var(--muted)]">{r.username ?? "–"}</td>
                      <td
                        className="whitespace-nowrap px-4 py-2 text-[var(--muted)]"
                        title={new Date(r.createdAt).toLocaleString()}
                      >
                        {fmtAgo(r.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
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

// ----------------------------------------------------------------- invites ----

function inviteStatus(inv: InviteCode): { label: string; cls: string; active: boolean } {
  if (inv.revokedAt) return { label: "Revoked", cls: "text-red-400", active: false };
  if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now())
    return { label: "Expired", cls: "text-[var(--muted)]", active: false };
  if (inv.uses >= inv.maxUses) return { label: "Used up", cls: "text-[var(--muted)]", active: false };
  return { label: "Active", cls: "text-emerald-400", active: true };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function Invites({ onChanged }: { onChanged: () => void }) {
  const [invites, setInvites] = useState<InviteCode[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [role, setRole] = useState<Role>("USER");
  const [maxUses, setMaxUses] = useState(1);
  const [expires, setExpires] = useState<string>("7"); // days, "" = never
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null); // `${id}:code|link`
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(
    () =>
      adminApi
        .invites()
        .then((l) => {
          setInvites(l);
          setLoadErr(false);
        })
        .catch(() => setLoadErr(true)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const linkFor = (code: string) =>
    `${window.location.origin}/register?code=${encodeURIComponent(code)}`;

  async function copy(inv: InviteCode, what: "code" | "link") {
    if (await copyText(what === "code" ? inv.code : linkFor(inv.code))) {
      setCopied(`${inv.id}:${what}`);
      setTimeout(() => setCopied((c) => (c === `${inv.id}:${what}` ? null : c)), 1500);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const uses = Math.round(maxUses);
    if (!(uses >= 1 && uses <= 1000)) return setError("Max uses must be 1 to 1000");
    const days = expires === "" ? null : Math.round(Number(expires));
    if (days != null && !(days >= 1 && days <= 365)) return setError("Expiry must be 1 to 365 days");
    setBusy(true);
    try {
      const inv = await adminApi.createInvite({
        role,
        maxUses: uses,
        expiresInDays: days,
        note: note.trim() || undefined,
      });
      setNote("");
      await load();
      onChanged();
      copy(inv, "link"); // handy: the new link is ready to paste
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the invite");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inv: InviteCode) {
    if (!confirm(`Revoke invite ${inv.code}? It can't be used after this.`)) return;
    try {
      await adminApi.revokeInvite(inv.id);
    } catch {
      /* reload shows the real state */
    }
    await load();
    onChanged();
  }

  const fieldCls =
    "rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 outline-none focus:border-[var(--accent)]";
  const list = invites ?? [];
  const shown = showInactive ? list : list.filter((i) => inviteStatus(i).active);
  const hiddenCount = list.length - list.filter((i) => inviteStatus(i).active).length;

  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Ticket size={18} /> Invites
      </h2>
      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4"
      >
        <div>
          <label className="mb-1 block text-xs text-[var(--muted)]">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={fieldCls}>
            <option value="USER">USER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-[var(--muted)]">Max uses</label>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
            className={`${fieldCls} w-24`}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-[var(--muted)]">Expires</label>
          <select value={expires} onChange={(e) => setExpires(e.target.value)} className={fieldCls}>
            <option value="1">in 1 day</option>
            <option value="7">in 7 days</option>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in 1 year</option>
            <option value="">Never</option>
          </select>
        </div>
        <div className="min-w-[160px] flex-1">
          <label className="mb-1 block text-xs text-[var(--muted)]">Note (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Who it's for"
            maxLength={200}
            className={`${fieldCls} w-full`}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create invite"}
        </button>
        {error && <div className="w-full text-sm text-red-400">{error}</div>}
      </form>

      {loadErr && <div className="mt-3 text-sm text-red-400">Couldn&apos;t load invites.</div>}

      {invites && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-2">Code</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2 text-right">Uses</th>
                <th className="px-4 py-2">Expires</th>
                <th className="px-4 py-2">Note</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((inv) => {
                const status = inviteStatus(inv);
                return (
                  <tr key={inv.id} className="border-b border-[var(--border)]/50">
                    <td className="whitespace-nowrap px-4 py-2 font-mono tracking-wider">{inv.code}</td>
                    <td className="px-4 py-2 text-xs">{inv.role}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {inv.uses}/{inv.maxUses}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-[var(--muted)]">
                      {inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : "Never"}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2 text-[var(--muted)]" title={inv.note ?? ""}>
                      {inv.note || "–"}
                      {inv.createdBy?.username && (
                        <span className="block text-[10px]">by {inv.createdBy.username}</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-xs font-medium ${status.cls}`}>{status.label}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-3 text-[var(--muted)]">
                        <button
                          onClick={() => copy(inv, "code")}
                          title="Copy code"
                          className="hover:text-white"
                        >
                          {copied === `${inv.id}:code` ? (
                            <Check size={15} className="text-emerald-400" />
                          ) : (
                            <Copy size={15} />
                          )}
                        </button>
                        <button
                          onClick={() => copy(inv, "link")}
                          title="Copy invite link"
                          className="hover:text-white"
                        >
                          {copied === `${inv.id}:link` ? (
                            <Check size={15} className="text-emerald-400" />
                          ) : (
                            <Link2 size={15} />
                          )}
                        </button>
                        {status.active && (
                          <button onClick={() => revoke(inv)} title="Revoke" className="hover:text-red-400">
                            <Ban size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-[var(--muted)]">
                    No active invites. Create one above to let someone sign up.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowInactive((s) => !s)}
          className="mt-2 text-xs text-[var(--muted)] hover:text-white"
        >
          {showInactive ? "Hide used, expired and revoked" : `Show ${hiddenCount} used, expired or revoked`}
        </button>
      )}
    </section>
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
    if (password.length < 10) return setError("Password must be at least 10 characters");
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
          placeholder="min 10 characters"
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
        className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-50"
      >
        Add user
      </button>
      {error && <div className="w-full text-sm text-red-400">{error}</div>}
    </form>
  );
}
