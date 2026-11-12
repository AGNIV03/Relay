"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { X, FileUp, ClipboardList, Link2, CheckCircle2 } from "lucide-react";
import { playlistApi } from "@/lib/api2";
import type { ImportResult, ImportSource } from "@/lib/types2";

const SOURCES: { key: ImportSource; label: string; Icon: typeof FileUp }[] = [
  { key: "m3u", label: "M3U file", Icon: FileUp },
  { key: "text", label: "Paste list", Icon: ClipboardList },
  { key: "spotify", label: "Spotify link", Icon: Link2 },
];

/** Import a playlist from an M3U file, a pasted "Artist - Title" list, or a
 *  Spotify playlist URL. The server fuzzy-matches each line against the library. */
export function ImportPlaylistDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: () => void;
}) {
  const [source, setSource] = useState<ImportSource>("m3u");
  const [name, setName] = useState("");
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError("");
    if (f.size > 5 * 1024 * 1024) {
      setError("That file is too large for a playlist");
      return;
    }
    setFileText(await f.text());
    setFileName(f.name);
    if (!name.trim()) setName(f.name.replace(/\.(m3u8?|txt)$/i, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const n = name.trim();
    if (!n) return setError("Give the playlist a name");
    let body: { name: string; source: ImportSource; content?: string; url?: string };
    if (source === "m3u") {
      if (!fileText) return setError("Choose an .m3u file");
      body = { name: n, source, content: fileText };
    } else if (source === "text") {
      if (!text.trim()) return setError("Paste at least one song");
      body = { name: n, source, content: text };
    } else {
      if (!/open\.spotify\.com\/playlist\//i.test(url)) return setError("Paste an open.spotify.com playlist link");
      body = { name: n, source, url: url.trim() };
    }
    setBusy(true);
    try {
      const r = await playlistApi.import(body);
      setResult(r);
      window.dispatchEvent(new Event("playlists-changed"));
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const fieldCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-lg font-semibold">Import playlist</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white" title="Close">
            <X size={18} />
          </button>
        </div>

        {result ? (
          <div className="overflow-y-auto p-5">
            <div className="mb-4 flex items-center gap-3">
              <CheckCircle2 size={28} className="shrink-0 text-[var(--accent)]" />
              <div>
                <div className="font-semibold">
                  Matched {result.matched} of {result.total} {result.total === 1 ? "song" : "songs"}
                </div>
                <div className="text-sm text-[var(--muted)]">
                  {result.matched > 0 ? `Added to “${name.trim()}”.` : "Nothing matched your library."}
                </div>
              </div>
            </div>
            {result.unmatched.length > 0 && (
              <div className="mb-4">
                <div className="mb-1 text-sm font-medium">Not found in your library</div>
                <ul className="max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--muted)]">
                  {result.unmatched.map((u, i) => (
                    <li key={`${u}-${i}`} className="truncate py-0.5" title={u}>
                      {u}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
              >
                Close
              </button>
              <Link
                href={`/playlists/${result.playlistId}`}
                onClick={onClose}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110"
              >
                Open playlist
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="overflow-y-auto p-5">
            <div className="mb-4 flex flex-wrap gap-2">
              {SOURCES.map(({ key, label, Icon }) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => {
                    setSource(key);
                    setError("");
                  }}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition ${
                    source === key
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "border border-[var(--border)] text-[var(--muted)] hover:text-white"
                  }`}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>

            {source === "m3u" && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-6 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-white"
                >
                  <FileUp size={16} /> {fileName || "Choose an .m3u or .m3u8 file"}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl,text/plain"
                  className="hidden"
                  onChange={onFile}
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Songs are matched by file name and #EXTINF titles.
                </p>
              </div>
            )}

            {source === "text" && (
              <div className="mb-4">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  placeholder={"Artist - Title\nArtist - Title\nTitle"}
                  className={`${fieldCls} resize-y font-mono`}
                />
                <p className="mt-1 text-xs text-[var(--muted)]">One song per line: “Artist - Title” or just the title.</p>
              </div>
            )}

            {source === "spotify" && (
              <div className="mb-4">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://open.spotify.com/playlist/…"
                  className={fieldCls}
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  The playlist must be public. Songs are matched against this library.
                </p>
              </div>
            )}

            <label className="mb-1 block text-sm text-[var(--muted)]">Playlist name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${fieldCls} mb-4`} />

            {error && <div className="mb-3 text-sm text-red-400">{error}</div>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
