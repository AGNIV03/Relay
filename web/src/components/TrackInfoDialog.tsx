"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X, Music, Lock } from "lucide-react";
import { api, ApiError, coverUrl } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { Track } from "@/lib/types";

/** The full track row as the library endpoints return it (a superset of `Track`). */
export type TrackDetails = Track & {
  uploaderId?: string | null;
  mbRecordingId?: string | null;
  acoustId?: string | null;
};

/** Body for PATCH /api/library/tracks/:id — only the changed fields are sent. */
interface TrackMetaPatch {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | null;
  genre?: string;
  trackNo?: number | null;
  discNo?: number | null;
}

type Fields = {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  trackNo: string;
  discNo: string;
};

function toFields(t: TrackDetails): Fields {
  return {
    title: t.title ?? "",
    artist: t.artist?.name ?? "",
    album: t.album?.title ?? "",
    year: t.album?.year != null ? String(t.album.year) : "",
    genre: t.genre ?? "",
    trackNo: t.trackNo != null ? String(t.trackNo) : "",
    discNo: t.discNo != null ? String(t.discNo) : "",
  };
}

/** Whole number in [min, max], null for an empty field, or an error message. */
function parseIntField(raw: string, label: string, min: number, max: number): number | null | string {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return `${label} must be a whole number`;
  const n = Number(s);
  if (n < min || n > max) return `${label} must be between ${min} and ${max}`;
  return n;
}

/** Build the PATCH body from the edited fields, or return field errors. */
function buildPatch(
  initial: Fields,
  f: Fields,
): { patch: TrackMetaPatch; errors: Partial<Record<keyof Fields, string>> } {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const patch: TrackMetaPatch = {};
  const changed = (k: keyof Fields) => f[k].trim() !== initial[k].trim();

  if (changed("title")) {
    if (!f.title.trim()) errors.title = "Title is required";
    else patch.title = f.title.trim();
  }
  if (changed("artist")) {
    if (!f.artist.trim()) errors.artist = "Artist is required";
    else patch.artist = f.artist.trim();
  }
  if (changed("album")) patch.album = f.album.trim();
  if (changed("genre")) patch.genre = f.genre.trim();

  const ints: [keyof Fields & ("year" | "trackNo" | "discNo"), string, number, number][] = [
    ["year", "Year", 0, 3000],
    ["trackNo", "Track #", 1, 999],
    ["discNo", "Disc #", 1, 99],
  ];
  for (const [k, label, min, max] of ints) {
    if (!changed(k)) continue;
    const v = parseIntField(f[k], label, min, max);
    if (typeof v === "string") errors[k] = v;
    else patch[k] = v;
  }
  return { patch, errors };
}

function fmtDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Song metadata popup: cover art, editable tags (title / artist / album / year /
 * genre / track # / disc #) and read-only file details. Editing is allowed for an
 * ADMIN or the track's uploader (enforced server-side too); everyone else sees
 * the same fields read-only. Saves only what changed; the audio file is never
 * rewritten — this edits the library database.
 */
export function TrackInfoDialog({
  trackId,
  track: initialTrack,
  onClose,
  onSaved,
}: {
  trackId: string;
  /** Optional row data to render instantly while the full track loads. */
  track?: Track;
  onClose: () => void;
  onSaved?: (track: TrackDetails) => void;
}) {
  const { user } = useAuth();
  const [track, setTrack] = useState<TrackDetails | null>(initialTrack ?? null);
  const [loadError, setLoadError] = useState(false);
  const [initial, setInitial] = useState<Fields | null>(initialTrack ? toFields(initialTrack) : null);
  const [fields, setFields] = useState<Fields | null>(initialTrack ? toFields(initialTrack) : null);
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);

  // Always hydrate the full row (uploader id, MusicBrainz ids, album year…).
  useEffect(() => {
    let active = true;
    api
      .get<{ tracks: TrackDetails[] }>(`/api/library/tracks/by-ids?ids=${encodeURIComponent(trackId)}`)
      .then(({ tracks }) => {
        if (!active) return;
        const t = tracks[0];
        if (!t) {
          setLoadError(true);
          return;
        }
        setTrack(t);
        setInitial(toFields(t));
        // Don't clobber edits the user started while it was loading.
        if (!dirtyRef.current) setFields(toFields(t));
      })
      .catch(() => active && setLoadError(true));
    return () => {
      active = false;
    };
  }, [trackId]);

  // Focus the first field on open; restore focus to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>("input:not([disabled])");
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      prev?.focus?.();
    };
  }, []);

  const canEdit =
    !!user &&
    !!track &&
    (user.role === "ADMIN" ||
      (track.uploaderId != null ? track.uploaderId === user.id : track.uploader?.username === user.username));
  // Until the full row arrives we can't be sure about ownership/uploaderId.
  const hydrated = !!track && "uploaderId" in track;
  const editable = canEdit && hydrated;

  const { patch, errors: liveErrors } = useMemo(
    () => (initial && fields ? buildPatch(initial, fields) : { patch: {}, errors: {} }),
    [initial, fields],
  );
  const dirty = Object.keys(patch).length > 0 || Object.keys(liveErrors).length > 0;

  function set<K extends keyof Fields>(k: K, v: string) {
    dirtyRef.current = true;
    setFields((f) => (f ? { ...f, [k]: v } : f));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setSaveError(null);
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!editable || saving || !initial || !fields) return;
    if (Object.keys(liveErrors).length) {
      setErrors(liveErrors);
      return;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.patch<TrackDetails>(`/api/library/tracks/${trackId}`, patch);
      setTrack(updated);
      setInitial(toFields(updated));
      setFields(toFields(updated));
      dirtyRef.current = false;
      onSaved?.(updated);
      window.dispatchEvent(new CustomEvent("track-updated", { detail: updated }));
      onClose();
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? err.status === 403
            ? "Only the uploader or an admin can edit this song."
            : err.status === 404
              ? "This song no longer exists."
              : err.status === 400
                ? "Some values are invalid — check the fields and try again."
                : err.message || "Couldn’t save changes."
          : "Couldn’t save changes.",
      );
    } finally {
      setSaving(false);
    }
  }

  // Escape closes; Tab cycles within the panel. Keys never leak to the app-wide
  // player shortcuts (Space on a focused button would otherwise toggle playback).
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  const details: [string, string][] = track
    ? [
        ["Duration", fmtDuration(track.duration)],
        ["Format", track.format ? track.format.toUpperCase() : "—"],
        ["Bitrate", track.bitrate ? `${track.bitrate} kbps` : "—"],
        ["File size", track.size ? `${(track.size / (1024 * 1024)).toFixed(1)} MB` : "—"],
        ["Source", track.uploader?.username ? `Uploaded by ${track.uploader.username}` : hydrated ? "Library scan" : "—"],
        [
          "Added",
          track.createdAt
            ? new Date(track.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "—",
        ],
      ]
    : [];

  const input = (
    k: keyof Fields,
    label: string,
    opts: { maxLength: number; numeric?: boolean; placeholder?: string; className?: string },
  ) => {
    const err = errors[k];
    return (
      <label className={`block ${opts.className ?? ""}`}>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          {label}
        </span>
        <input
          value={fields?.[k] ?? ""}
          onChange={(e) => set(k, e.target.value)}
          readOnly={!editable}
          disabled={!fields}
          maxLength={opts.maxLength}
          inputMode={opts.numeric ? "numeric" : undefined}
          placeholder={editable ? opts.placeholder : undefined}
          aria-invalid={!!err}
          className={`w-full rounded-md border bg-[var(--panel-2)] px-3 py-2 text-sm outline-none transition focus:border-[var(--accent)] ${
            err ? "border-red-500" : "border-[var(--border)]"
          } ${editable ? "" : "cursor-default text-[var(--muted)] focus:border-[var(--border)]"}`}
        />
        {err && <span className="mt-1 block text-xs text-red-400">{err}</span>}
      </label>
    );
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="track-info-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none"
      >
        {/* Header */}
        <div className="flex items-start gap-4 border-b border-[var(--border)] p-5">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--panel-2)]">
            {!coverFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                // Keyed by album so a re-link shows the new album's art.
                src={`${coverUrl(trackId)}&v=${encodeURIComponent(track?.album?.id ?? "")}`}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setCoverFailed(true)}
              />
            ) : (
              <Music size={28} className="text-[var(--muted)]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
              {editable ? "Edit song info" : "Song info"}
            </div>
            <h2 id="track-info-title" className="truncate text-lg font-bold">
              {track?.title ?? "…"}
            </h2>
            <div className="truncate text-sm text-[var(--muted)]">
              {track?.artist?.name}
              {track?.album?.title && <> · {track.album.title}</>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--muted)] hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {loadError && !track ? (
              <div className="py-6 text-center text-sm text-[var(--muted)]">Couldn’t load this song.</div>
            ) : (
              <>
                {track && hydrated && !canEdit && (
                  <div className="mb-4 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-xs text-[var(--muted)]">
                    <Lock size={12} className="shrink-0" />
                    Only the uploader or an admin can edit this song
                  </div>
                )}

                <div className="grid grid-cols-6 gap-3">
                  {input("title", "Title", { maxLength: 300, className: "col-span-6" })}
                  {input("artist", "Artist", { maxLength: 300, className: "col-span-6" })}
                  {input("album", "Album", {
                    maxLength: 300,
                    placeholder: "Unknown Album",
                    className: "col-span-6 sm:col-span-4",
                  })}
                  {input("year", "Year", { maxLength: 4, numeric: true, className: "col-span-3 sm:col-span-2" })}
                  {input("genre", "Genre", { maxLength: 100, className: "col-span-3 sm:col-span-2" })}
                  {input("trackNo", "Track #", { maxLength: 3, numeric: true, className: "col-span-3 sm:col-span-2" })}
                  {input("discNo", "Disc #", { maxLength: 2, numeric: true, className: "col-span-3 sm:col-span-2" })}
                </div>
                {editable && (
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    Year applies to the whole album. Changes update the library only — the audio file isn’t modified.
                  </p>
                )}

                {details.length > 0 && (
                  <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--border)] pt-4 text-sm sm:grid-cols-3">
                    {details.map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{k}</dt>
                        <dd className="truncate" title={v}>
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {(track?.mbRecordingId || track?.acoustId) && (
                  <div className="mt-3 space-y-0.5 break-all text-[11px] text-[var(--muted)] opacity-80">
                    {track.mbRecordingId && <div>MusicBrainz recording: {track.mbRecordingId}</div>}
                    {track.acoustId && <div>AcoustID: {track.acoustId}</div>}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
            {saveError && <div className="mr-auto text-xs text-red-400">{saveError}</div>}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-white"
            >
              {editable ? "Cancel" : "Close"}
            </button>
            {editable && (
              <button
                type="submit"
                disabled={!dirty || saving}
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
