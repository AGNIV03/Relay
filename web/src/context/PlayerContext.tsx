"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api, streamUrl, coverUrl, tokens } from "@/lib/api";
import type { Track, Lyrics, HostActivity, ChorusState } from "@/lib/types";

export type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  queue: Track[];
  index: number;
  current: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  lyrics: Lyrics | null;
  /** Play a list of tracks starting at `start`. */
  playQueue: (tracks: Track[], start?: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  coverFor: (t: Track) => string;
  /** Append a track to the end of the queue. */
  addToQueue: (t: Track) => void;
  /** Insert a track to play right after the current one. */
  playNext: (t: Track) => void;
  /** Remove the track at queue position `i`. */
  removeFromQueue: (i: number) => void;
  /** Jump to queue position `i`. */
  playAt: (i: number) => void;
  /** Whether a listen-along session is active. */
  listeningAlong: boolean;
  listenHostName: string | null;
  listenHostId: string | null;
  /** Start following another user's playback. */
  startListenAlong: (userId: string, name: string) => void;
  /** Stop following; finish the current song, then return to the saved queue. */
  stopListenAlong: () => void;
  // ---- Chorus (collaborative synced listening) ----
  chorus: ChorusState | null;
  startChorus: (mode: "open" | "ask") => void;
  setChorusMode: (mode: "open" | "ask") => void;
  joinChorus: (hostId: string) => Promise<string>;
  leaveChorus: () => void;
  approveChorus: (userId: string) => void;
  denyChorus: (userId: string) => void;
  removeFromChorus: (userId: string) => void;
}

const PlayerContext = createContext<PlayerState | null>(null);

/** Fisher–Yates over [0..n), with `first` moved to the front so playback continues. */
function shuffledOrder(n: number, first: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const fi = arr.indexOf(first);
  if (fi > 0) [arr[0], arr[fi]] = [arr[fi], arr[0]];
  return arr;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState(1);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [shuffle, setShuffle] = useState(false);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const scrobbled = useRef<Set<string>>(new Set());
  const [listenHost, setListenHost] = useState<{ id: string; name: string } | null>(null);
  const [chorus, setChorus] = useState<ChorusState | null>(null);
  const chorusRef = useRef<ChorusState | null>(null);
  const pendingSeekRef = useRef<number | null>(null); // seconds to seek to after the next load
  useEffect(() => {
    chorusRef.current = chorus;
  }, [chorus]);

  const current = queue[index] ?? null;

  // Refs the (once-registered) audio event handlers read from.
  const queueRef = useRef<Track[]>([]);
  const indexRef = useRef(0);
  const repeatRef = useRef<RepeatMode>("off");
  const orderRef = useRef<number[]>([]); // playback order: positions -> queue index
  // Listen-along: saved session to restore on stop, + "finish current then restore" flag.
  const savedSessionRef = useRef<{ queue: Track[]; index: number; order: number[] } | null>(null);
  const restoreAfterCurrentRef = useRef(false);
  const listenHostRef = useRef<string | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);
  useEffect(() => {
    currentIdRef.current = current?.id ?? null;
  }, [current?.id]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    listenHostRef.current = listenHost?.id ?? null;
  }, [listenHost]);

  // Advance helper shared by manual-next and natural-end.
  const advance = useCallback((dir: 1 | -1, loop: boolean): number | null => {
    const order = orderRef.current;
    const n = order.length;
    if (n === 0) return null;
    const pos = order.indexOf(indexRef.current);
    let np = (pos < 0 ? 0 : pos) + dir;
    if (np >= n) {
      if (!loop) return null;
      np = 0;
    } else if (np < 0) {
      np = n - 1;
    }
    return order[np];
  }, []);

  // Create the audio element once.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;
    const onTime = () => {
      setPosition(audio.currentTime);
      const t = queueRef.current[indexRef.current];
      if (t && audio.currentTime > 5 && !scrobbled.current.has(t.id)) {
        scrobbled.current.add(t.id);
        api.post("/api/library/scrobble", { trackId: t.id }).catch(() => {});
      }
    };
    const onMeta = () => {
      setDuration(audio.duration || 0);
      // Apply a pending chorus seek once the new track's metadata is ready.
      if (pendingSeekRef.current != null) {
        audio.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = null;
      }
    };
    const onEnd = () => {
      // A stopped listen-along session lets the current song finish, then
      // restores the queue the user had before they started following.
      if (restoreAfterCurrentRef.current) {
        restoreAfterCurrentRef.current = false;
        const saved = savedSessionRef.current;
        savedSessionRef.current = null;
        if (saved && saved.queue.length) {
          orderRef.current = saved.order;
          const pos = saved.order.indexOf(saved.index);
          const np = pos >= 0 && pos + 1 < saved.order.length ? saved.order[pos + 1] : saved.order[0];
          scrobbled.current.clear();
          setQueue(saved.queue);
          setIndex(np);
        } else {
          setPlaying(false);
        }
        return;
      }
      if (repeatRef.current === "one") {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      const target = advance(1, repeatRef.current === "all");
      if (target === null) {
        setPlaying(false); // repeat off + last track -> stop
        return;
      }
      setIndex(target);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.pause();
      audio.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load + play whenever the current track changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    audio.src = streamUrl(current.id);
    audio.play().catch(() => setPlaying(false));
    setPosition(0);
    setLyrics(null);
    api
      .get<Lyrics>(`/api/library/tracks/${current.id}/lyrics`)
      .then(setLyrics)
      .catch(() => setLyrics(null));
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist?.name ?? "",
        album: current.album?.title ?? "",
        artwork: [{ src: coverUrl(current.id), sizes: "512x512", type: "image/jpeg" }],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const playQueue = useCallback(
    (tracks: Track[], start = 0) => {
      if (!tracks.length) return;
      scrobbled.current.clear();
      orderRef.current = shuffle
        ? shuffledOrder(tracks.length, start)
        : Array.from({ length: tracks.length }, (_, i) => i);
      setQueue(tracks);
      setIndex(start);
    },
    [shuffle],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, [current]);

  // Manual next/prev always loop around the ends (playlist looping).
  const next = useCallback(() => {
    const target = advance(1, true);
    if (target !== null) setIndex(target);
  }, [advance]);
  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const target = advance(-1, true);
    if (target !== null) setIndex(target);
  }, [advance]);

  const seek = useCallback((sec: number) => {
    if (audioRef.current) audioRef.current.currentTime = sec;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVol(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const toggleRepeat = useCallback(
    () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
    [],
  );

  const toggleShuffle = useCallback(() => {
    setShuffle((s) => {
      const ns = !s;
      const n = queueRef.current.length;
      orderRef.current = ns
        ? shuffledOrder(n, indexRef.current)
        : Array.from({ length: n }, (_, i) => i);
      return ns;
    });
  }, []);

  const coverFor = useCallback((t: Track) => coverUrl(t.id), []);

  // --- Queue editing ---------------------------------------------------------
  const addToQueue = useCallback((t: Track) => {
    setQueue((q) => {
      if (!q.length) {
        orderRef.current = [0];
        scrobbled.current.clear();
        setIndex(0);
        return [t];
      }
      orderRef.current = [...orderRef.current, q.length];
      return [...q, t];
    });
  }, []);

  const playNext = useCallback((t: Track) => {
    setQueue((q) => {
      if (!q.length) {
        orderRef.current = [0];
        scrobbled.current.clear();
        setIndex(0);
        return [t];
      }
      const newIdx = q.length;
      const order = orderRef.current;
      const pos = order.indexOf(indexRef.current);
      const insertAt = pos < 0 ? order.length : pos + 1;
      orderRef.current = [...order.slice(0, insertAt), newIdx, ...order.slice(insertAt)];
      return [...q, t];
    });
  }, []);

  const removeFromQueue = useCallback((i: number) => {
    setQueue((q) => {
      if (i < 0 || i >= q.length) return q;
      if (i === indexRef.current) return q; // don't yank the playing track
      const nq = q.filter((_, k) => k !== i);
      // Rebuild order: drop position i, shift higher indices down by one.
      orderRef.current = orderRef.current
        .filter((idx) => idx !== i)
        .map((idx) => (idx > i ? idx - 1 : idx));
      if (indexRef.current > i) setIndex((n) => n - 1);
      return nq;
    });
  }, []);

  const playAt = useCallback((i: number) => {
    if (i >= 0 && i < queueRef.current.length) setIndex(i);
  }, []);

  // --- Presence heartbeat ----------------------------------------------------
  // Post what we're playing every 12s, and immediately on track/play changes.
  useEffect(() => {
    const post = () => {
      if (!tokens.access) return; // not signed in yet
      const t = queueRef.current[indexRef.current];
      api
        .post("/api/social/activity", {
          trackId: t?.id ?? null,
          positionMs: Math.round((audioRef.current?.currentTime ?? 0) * 1000),
          playing: playingRef.current,
        })
        .catch(() => {});
    };
    post();
    const id = setInterval(post, 12_000);
    return () => clearInterval(id);
  }, [current?.id, playing]);

  // --- Listen along ----------------------------------------------------------
  const startListenAlong = useCallback((userId: string, name: string) => {
    // Save the current session so we can return to it later.
    savedSessionRef.current = {
      queue: queueRef.current,
      index: indexRef.current,
      order: orderRef.current,
    };
    restoreAfterCurrentRef.current = false;
    setListenHost({ id: userId, name });
  }, []);

  const stopListenAlong = useCallback(() => {
    setListenHost(null);
    // Let the current song finish, then restore the saved queue (handled in onEnd).
    if (savedSessionRef.current && queueRef.current.length) {
      restoreAfterCurrentRef.current = true;
    }
  }, []);

  // Poll the host every 3s while following: match their track + position + seeks.
  useEffect(() => {
    if (!listenHost) return;
    let cancelled = false;
    const sync = async () => {
      let act: HostActivity;
      try {
        act = await api.get<HostActivity>(`/api/social/activity/${listenHost.id}`);
      } catch {
        return;
      }
      if (cancelled || listenHostRef.current !== listenHost.id) return;
      // Host went offline — leave the session, finish the current song, then
      // return to our own queue (same as a manual Stop).
      if (!act.online) {
        stopListenAlong();
        return;
      }
      if (!act.track || !act.trackId) return;
      const audio = audioRef.current;
      if (!audio) return;
      // Extrapolate the host's position if they're still playing.
      let targetMs = act.positionMs;
      if (act.playing && act.updatedAt) {
        targetMs += Date.now() - new Date(act.updatedAt).getTime();
      }
      const targetSec = targetMs / 1000;
      if (currentIdRef.current !== act.trackId) {
        // Host changed track — follow them onto it.
        scrobbled.current.clear();
        orderRef.current = [0];
        setQueue([act.track]);
        setIndex(0);
        // Position is applied once metadata loads.
        const onReady = () => {
          audio.currentTime = Math.max(0, targetSec);
          if (act.playing) audio.play().catch(() => {});
          audio.removeEventListener("loadedmetadata", onReady);
        };
        audio.addEventListener("loadedmetadata", onReady);
      } else {
        // Same track — correct drift / follow seeks.
        if (Math.abs(audio.currentTime - targetSec) > 2.5) {
          audio.currentTime = Math.max(0, targetSec);
        }
        if (act.playing && audio.paused) audio.play().catch(() => {});
        if (!act.playing && !audio.paused) audio.pause();
      }
    };
    sync();
    const id = setInterval(sync, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [listenHost]);

  // ---- Chorus (collaborative synced listening) ----
  const lastAppliedSig = useRef("");
  const chorusSig = (ids: string[], idx: number, isPlaying: boolean) =>
    `${ids.join(",")}#${idx}#${isPlaying}`;

  // Reconcile local playback with the shared chorus state.
  const chorusSync = useCallback(async () => {
    let c: ChorusState | null;
    try {
      c = await api.get<ChorusState | null>("/api/chorus");
    } catch {
      return;
    }
    if (!c) {
      if (chorusRef.current) setChorus(null);
      return;
    }
    setChorus(c);
    if (!c.queueIds.length) return;
    lastAppliedSig.current = chorusSig(c.queueIds, c.index, c.playing); // suppress echo
    const audio = audioRef.current;
    if (!audio) return;

    const sharedTrackId =
      c.index >= 0 && c.index < c.queueIds.length ? c.queueIds[c.index] : null;
    const sigMatch =
      queueRef.current.map((t) => t.id).join(",") === c.queueIds.join(",") &&
      indexRef.current === c.index;
    let targetMs = c.positionMs;
    if (c.playing) targetMs += Date.now() - c.updatedAt;
    const targetSec = Math.max(0, targetMs / 1000);

    if (!sigMatch) {
      // If we're the host and the shared state still reflects our own last update,
      // our local state is newer (e.g. the track just auto-advanced) — push it
      // instead of reverting to the stale shared index.
      if (c.isHost && c.controllerId === c.hostId) {
        api
          .post("/api/chorus/state", {
            queue: queueRef.current.map((t) => t.id),
            index: indexRef.current,
            positionMs: Math.round(audio.currentTime * 1000),
            playing: playingRef.current,
          })
          .catch(() => {});
        return;
      }
      orderRef.current = Array.from({ length: c.queue.length }, (_, i) => i);
      const sameTrack = currentIdRef.current === sharedTrackId;
      scrobbled.current.clear();
      setQueue(c.queue);
      setIndex(c.index);
      if (sameTrack) {
        if (Math.abs(audio.currentTime - targetSec) > 3) audio.currentTime = targetSec;
        if (c.playing) audio.play().catch(() => {});
        else audio.pause();
      } else {
        // New track: the load effect will play from 0; seek once it's ready.
        pendingSeekRef.current = targetSec;
        if (!c.playing) setTimeout(() => audio.pause(), 80);
      }
      return;
    }

    if (c.isHost) {
      // Host drives the shared timeline.
      api
        .post("/api/chorus/state", {
          queue: queueRef.current.map((t) => t.id),
          index: indexRef.current,
          positionMs: Math.round(audio.currentTime * 1000),
          playing: playingRef.current,
        })
        .catch(() => {});
    } else {
      if (Math.abs(audio.currentTime - targetSec) > 3) audio.currentTime = targetSec;
      if (c.playing && audio.paused) audio.play().catch(() => {});
      if (!c.playing && !audio.paused) audio.pause();
    }
  }, []);

  // Poll while in a chorus.
  useEffect(() => {
    if (!chorus) return;
    chorusSync();
    const id = setInterval(chorusSync, 2000);
    return () => clearInterval(id);
  }, [chorus?.hostId, chorusSync]);

  // Broadcast local content/play changes to the chorus (skipping echoes of state
  // we just adopted from the server).
  useEffect(() => {
    if (!chorusRef.current) return;
    const ids = queue.map((t) => t.id);
    const sig = chorusSig(ids, index, playing);
    if (sig === lastAppliedSig.current) return;
    lastAppliedSig.current = sig;
    api
      .post("/api/chorus/state", {
        queue: ids,
        index,
        positionMs: Math.round((audioRef.current?.currentTime ?? 0) * 1000),
        playing,
      })
      .catch(() => {});
  }, [queue, index, playing]);

  const startChorus = useCallback(async (mode: "open" | "ask") => {
    try {
      const ids = queueRef.current.map((t) => t.id);
      const c = await api.post<ChorusState>("/api/chorus/start", {
        mode,
        queue: ids,
        index: indexRef.current,
        positionMs: Math.round((audioRef.current?.currentTime ?? 0) * 1000),
        playing: playingRef.current,
      });
      lastAppliedSig.current = chorusSig(c.queueIds, c.index, c.playing);
      setChorus(c);
    } catch {
      /* ignore */
    }
  }, []);

  const setChorusMode = useCallback(
    async (mode: "open" | "ask") => {
      await api.post("/api/chorus/mode", { mode }).catch(() => {});
      chorusSync();
    },
    [chorusSync],
  );

  const joinChorus = useCallback(
    async (hostId: string): Promise<string> => {
      const r = await api.post<{ status: string }>("/api/chorus/join", { hostId });
      await chorusSync();
      return r.status;
    },
    [chorusSync],
  );

  const leaveChorus = useCallback(async () => {
    await api.post("/api/chorus/leave").catch(() => {});
    setChorus(null);
  }, []);

  const approveChorus = useCallback(
    async (userId: string) => {
      await api.post("/api/chorus/approve", { userId }).catch(() => {});
      chorusSync();
    },
    [chorusSync],
  );
  const denyChorus = useCallback(
    async (userId: string) => {
      await api.post("/api/chorus/deny", { userId }).catch(() => {});
      chorusSync();
    },
    [chorusSync],
  );
  const removeFromChorus = useCallback(
    async (userId: string) => {
      await api.post("/api/chorus/remove", { userId }).catch(() => {});
      chorusSync();
    },
    [chorusSync],
  );

  // Browser media-key / lock-screen controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => toggle());
  }, [next, prev, toggle]);

  return (
    <PlayerContext.Provider
      value={{
        queue,
        index,
        current,
        playing,
        position,
        duration,
        volume,
        repeat,
        shuffle,
        lyrics,
        playQueue,
        toggle,
        next,
        prev,
        seek,
        setVolume,
        toggleRepeat,
        toggleShuffle,
        coverFor,
        addToQueue,
        playNext,
        removeFromQueue,
        playAt,
        listeningAlong: listenHost !== null,
        listenHostName: listenHost?.name ?? null,
        listenHostId: listenHost?.id ?? null,
        startListenAlong,
        stopListenAlong,
        chorus,
        startChorus,
        setChorusMode,
        joinChorus,
        leaveChorus,
        approveChorus,
        denyChorus,
        removeFromChorus,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
