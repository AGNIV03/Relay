"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Radio, SlidersHorizontal } from "lucide-react";
import { scrobblingApi } from "@/lib/api2";
import type { ScrobblingStatus } from "@/lib/types2";
import { loadPlaybackSettings, savePlaybackSetting, type PlaybackSettings } from "@/lib/prefs2";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>
      <PlaybackSection />
      <ScrobblingSection />
    </div>
  );
}

// ---------------------------------------------------------------- playback ----

function PlaybackSection() {
  // localStorage is client-only: start from defaults, load after mount.
  const [s, setS] = useState<PlaybackSettings>({ autoplay: true, normalize: true, fadeSeconds: 0 });
  useEffect(() => setS(loadPlaybackSettings()), []);

  function set<K extends keyof PlaybackSettings>(key: K, value: PlaybackSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    savePlaybackSetting(key, value);
  }

  return (
    <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <h2 className="mb-4 flex items-center gap-2 font-semibold">
        <SlidersHorizontal size={18} /> Playback
      </h2>
      <ToggleRow
        label="Autoplay"
        hint="When the queue ends, keep playing similar songs."
        on={s.autoplay}
        onChange={(v) => set("autoplay", v)}
      />
      <ToggleRow
        label="Normalize volume"
        hint="Play every song at a similar loudness."
        on={s.normalize}
        onChange={(v) => set("normalize", v)}
      />
      <div className="pt-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Crossfade</div>
            <div className="text-xs text-[var(--muted)]">Blend the end of a song into the next.</div>
          </div>
          <div className="w-14 text-right text-sm tabular-nums text-[var(--muted)]">
            {s.fadeSeconds === 0 ? "Off" : `${s.fadeSeconds}s`}
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={12}
          step={1}
          value={s.fadeSeconds}
          onChange={(e) => set("fadeSeconds", Number(e.target.value))}
          className="mt-3 w-full"
          aria-label="Crossfade seconds"
        />
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border)]/60 py-3 first-of-type:pt-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-[var(--muted)]">{hint}</div>
      </div>
      <Switch on={on} onChange={onChange} label={label} />
    </div>
  );
}

function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        on ? "bg-[var(--accent)]" : "bg-[var(--panel-2)]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

// -------------------------------------------------------------- scrobbling ----

function ScrobblingSection() {
  const [status, setStatus] = useState<ScrobblingStatus | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [lbToken, setLbToken] = useState("");
  const [lbBusy, setLbBusy] = useState(false);
  const [lbErr, setLbErr] = useState<string | null>(null);
  const [lfToken, setLfToken] = useState<string | null>(null); // pending Last.fm auth
  const [lfBusy, setLfBusy] = useState(false);
  const [lfErr, setLfErr] = useState<string | null>(null);

  useEffect(() => {
    scrobblingApi
      .status()
      .then(setStatus)
      .catch(() => setLoadErr(true));
  }, []);

  async function connectLb(e: React.FormEvent) {
    e.preventDefault();
    if (!lbToken.trim()) return;
    setLbBusy(true);
    setLbErr(null);
    try {
      setStatus(await scrobblingApi.connectListenBrainz(lbToken.trim()));
      setLbToken("");
    } catch (err) {
      setLbErr(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setLbBusy(false);
    }
  }

  async function disconnectLb() {
    setLbBusy(true);
    setLbErr(null);
    try {
      setStatus(await scrobblingApi.disconnectListenBrainz());
    } catch (err) {
      setLbErr(err instanceof Error ? err.message : "Couldn't disconnect");
    } finally {
      setLbBusy(false);
    }
  }

  async function startLf() {
    setLfBusy(true);
    setLfErr(null);
    // Open the tab synchronously (inside the click) so popup blockers allow it,
    // then point it at Last.fm once the server hands back the auth URL.
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null;
    try {
      const r = await scrobblingApi.startLastfm();
      setLfToken(r.token);
      if (win) win.location.href = r.authUrl;
      else window.open(r.authUrl, "_blank", "noopener");
    } catch (err) {
      win?.close();
      setLfErr(err instanceof Error ? err.message : "Couldn't start Last.fm sign-in");
    } finally {
      setLfBusy(false);
    }
  }

  async function completeLf() {
    if (!lfToken) return;
    setLfBusy(true);
    setLfErr(null);
    try {
      setStatus(await scrobblingApi.completeLastfm(lfToken));
      setLfToken(null);
    } catch (err) {
      setLfErr(
        err instanceof Error && err.message
          ? err.message
          : "Not approved yet. Approve Relay on Last.fm, then try again.",
      );
    } finally {
      setLfBusy(false);
    }
  }

  async function disconnectLf() {
    setLfBusy(true);
    setLfErr(null);
    try {
      setStatus(await scrobblingApi.disconnectLastfm());
    } catch (err) {
      setLfErr(err instanceof Error ? err.message : "Couldn't disconnect");
    } finally {
      setLfBusy(false);
    }
  }

  const btn =
    "rounded-lg px-4 py-1.5 text-sm font-medium transition disabled:opacity-50";
  const primary = `${btn} bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110`;
  const secondary = `${btn} border border-[var(--border)] hover:bg-[var(--panel-2)]`;

  return (
    <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <Radio size={18} /> Scrobbling
      </h2>
      <p className="mb-4 text-xs text-[var(--muted)]">
        Send what you listen to on Relay to your ListenBrainz or Last.fm profile.
      </p>

      {loadErr && !status && (
        <div className="text-sm text-[var(--muted)]">Scrobbling isn&apos;t available on this server.</div>
      )}
      {!loadErr && !status && <div className="text-sm text-[var(--muted)]">Loading…</div>}

      {status && (
        <>
          {/* ListenBrainz */}
          <div className="border-b border-[var(--border)]/60 pb-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">ListenBrainz</div>
              {status.listenbrainz.connected && (
                <span className="text-xs text-emerald-400">
                  Connected{status.listenbrainz.username ? ` as ${status.listenbrainz.username}` : ""}
                </span>
              )}
            </div>
            {status.listenbrainz.connected ? (
              <button onClick={disconnectLb} disabled={lbBusy} className={secondary}>
                Disconnect
              </button>
            ) : (
              <form onSubmit={connectLb} className="flex gap-2">
                <input
                  value={lbToken}
                  onChange={(e) => setLbToken(e.target.value)}
                  placeholder="User token"
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                />
                <button type="submit" disabled={lbBusy || !lbToken.trim()} className={primary}>
                  {lbBusy ? "Connecting…" : "Connect"}
                </button>
              </form>
            )}
            {!status.listenbrainz.connected && (
              <a
                href="https://listenbrainz.org/settings/"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-white"
              >
                Find your token in ListenBrainz settings <ExternalLink size={11} />
              </a>
            )}
            {lbErr && <div className="mt-2 text-sm text-red-400">{lbErr}</div>}
          </div>

          {/* Last.fm (only when the server has API keys) */}
          {status.lastfm.available && (
            <div className="pt-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">Last.fm</div>
                {status.lastfm.connected && (
                  <span className="text-xs text-emerald-400">
                    Connected{status.lastfm.username ? ` as ${status.lastfm.username}` : ""}
                  </span>
                )}
              </div>
              {status.lastfm.connected ? (
                <button onClick={disconnectLf} disabled={lfBusy} className={secondary}>
                  Disconnect
                </button>
              ) : lfToken ? (
                <div>
                  <p className="mb-2 text-xs text-[var(--muted)]">
                    Approve Relay in the Last.fm tab that just opened, then come back here.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={completeLf} disabled={lfBusy} className={primary}>
                      {lfBusy ? "Checking…" : "I've approved it"}
                    </button>
                    <button onClick={() => setLfToken(null)} disabled={lfBusy} className={secondary}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={startLf} disabled={lfBusy} className={primary}>
                  {lfBusy ? "Opening…" : "Connect Last.fm"}
                </button>
              )}
              {lfErr && <div className="mt-2 text-sm text-red-400">{lfErr}</div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
