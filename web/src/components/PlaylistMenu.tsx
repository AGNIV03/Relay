"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Users, Trash2, LogOut, X, Check, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import type { Friend, UserRef } from "@/lib/types";

/** Playlist actions menu: rename / manage collaborators / delete (owner), or
 *  leave (collaborator). `owned` gates the owner-only actions. */
export function PlaylistMenu({
  playlistId,
  name,
  owned,
  onChanged,
  onDeleted,
}: {
  playlistId: string;
  name: string;
  owned: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(name);
  const [collabOpen, setCollabOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function rename() {
    const n = newName.trim();
    if (!n) return;
    await api.patch(`/api/playlists/${playlistId}`, { name: n }).catch(() => {});
    setRenaming(false);
    onChanged();
  }

  async function del() {
    if (!confirm(`Delete the playlist "${name}"? This can't be undone.`)) return;
    await api.del(`/api/playlists/${playlistId}`).catch(() => {});
    setOpen(false);
    onDeleted();
  }

  async function leave() {
    if (!user) return;
    await api.del(`/api/playlists/${playlistId}/collaborators/${user.id}`).catch(() => {});
    setOpen(false);
    onDeleted();
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[var(--muted)] transition hover:text-white"
        title="More"
      >
        <MoreHorizontal size={26} />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] py-1 text-sm shadow-xl">
          {owned ? (
            <>
              <button
                onClick={() => {
                  setNewName(name);
                  setRenaming(true);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                <Pencil size={15} /> Rename
              </button>
              <button
                onClick={() => {
                  setCollabOpen(true);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel)]"
              >
                <Users size={15} /> Manage collaborators
              </button>
              <div className="my-1 border-t border-[var(--border)]" />
              <button
                onClick={del}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-400 hover:bg-[var(--panel)]"
              >
                <Trash2 size={15} /> Delete playlist
              </button>
            </>
          ) : (
            <button
              onClick={leave}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-400 hover:bg-[var(--panel)]"
            >
              <LogOut size={15} /> Leave playlist
            </button>
          )}
        </div>
      )}

      {renaming && (
        <Modal onClose={() => setRenaming(false)} title="Rename playlist">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && rename()}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setRenaming(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={rename}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)]"
            >
              Save
            </button>
          </div>
        </Modal>
      )}

      {collabOpen && (
        <CollaboratorsModal playlistId={playlistId} onClose={() => setCollabOpen(false)} />
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Add/remove collaborators by toggling each other user. */
function CollaboratorsModal({ playlistId, onClose }: { playlistId: string; onClose: () => void }) {
  const [users, setUsers] = useState<Friend[]>([]);
  const [collabIds, setCollabIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const [friends, info] = await Promise.all([
      api.get<Friend[]>("/api/social/friends").catch(() => [] as Friend[]),
      api
        .get<{ collaborators: UserRef[] }>(`/api/playlists/${playlistId}/collaborators`)
        .catch(() => ({ collaborators: [] as UserRef[] })),
    ]);
    setUsers(friends);
    setCollabIds(new Set(info.collaborators.map((c) => c.id)));
    setLoading(false);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId]);

  async function toggle(userId: string, isCollab: boolean) {
    setBusy(userId);
    try {
      if (isCollab) await api.del(`/api/playlists/${playlistId}/collaborators/${userId}`);
      else await api.post(`/api/playlists/${playlistId}/collaborators`, { userId });
      setCollabIds((prev) => {
        const next = new Set(prev);
        if (isCollab) next.delete(userId);
        else next.add(userId);
        return next;
      });
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Collaborators" onClose={onClose}>
      {loading ? (
        <div className="py-4 text-sm text-[var(--muted)]">Loading…</div>
      ) : users.length === 0 ? (
        <div className="py-4 text-sm text-[var(--muted)]">No other users to add.</div>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {users.map((u) => {
            const isCollab = collabIds.has(u.id);
            return (
              <div key={u.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--panel-2)] text-xs font-bold">
                  {u.username.charAt(0).toUpperCase()}
                </div>
                <span className="flex-1 truncate text-sm">{u.username}</span>
                <button
                  disabled={busy === u.id}
                  onClick={() => toggle(u.id, isCollab)}
                  className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
                    isCollab
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "border border-[var(--border)] text-[var(--muted)] hover:text-white"
                  }`}
                >
                  {isCollab ? (
                    <>
                      <Check size={13} /> Added
                    </>
                  ) : (
                    <>
                      <Plus size={13} /> Add
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
