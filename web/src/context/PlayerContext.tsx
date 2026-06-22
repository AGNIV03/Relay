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
import type { Track, Lyrics, HostActivity, ChorusState, ChorusPatch } from "@/lib/types";

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
  // ---- Chorus (collaborative listening; audio only on the host's device) ----
  chorus: ChorusState | null;
  /** True when we're a silent, approved member acting as a remote control. */
  isChorusMember: boolean;
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
  // Chorus long-poll engine.
  const chorusVersionRef = useRef(0);
  const chorusLoopRef = useRef(false);
  const chorusAbortRef = useRef<AbortController | null>(null);
  const chorusAutoStopRef = useRef(false); // user stopped — skip auto-start until next play
  // Silent member's extrapolated position.
  const [memberPos, setMemberPos] = useState(0);
  const memberBaseMsRef = useRef(0);
  const memberBaseAtRef = useRef(0);
  useEffect(() => {
    chorusRef.current = chorus;
  }, [chorus]);

  const localCurrent = queue[index] ?? null;
  const isChorusHost = !!chorus && chorus.isHost;
  const isChorusMember = !!chorus && !chorus.isHost && !chorus.isPending;

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
    currentIdRef.current = localCurrent?.id ?? null;
  }, [localCurrent?.id]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    listenHostRef.current = listenHost?.id ?? null;
  }, [listenHost]);

  // True when we're a silent, approved chorus member (reads the ref for callbacks).
  const memberNow = useCallback(() => {
    const c = chorusRef.current;
    return !!c && !c.isHost && !c.isPending;
  }, []);

  // A silent member's extrapolated position in ms (no local audio to read).
  const memberPositionMs = useCallback(() => {
    const c = chorusRef.current;
    if (!c) return 0;
    let ms = memberBaseMsRef.current;
    if (c.playing) ms += Date.now() - memberBaseAtRef.current;
    const dur = (c.queue[c.index]?.duration ?? 0) * 1000;
    if (dur > 0 && ms > dur) ms = dur;
    return ms < 0 ? 0 : ms;
  }, []);

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
      // Apply a pending seek (chorus command / adopt) once metadata is ready.
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
        // End of the queue (repeat off): finish, stop, and clear the controls
        // entirely instead of freezing at the last second.
        audio.pause();
        audio.src = "";
        scrobbled.current.clear();
        orderRef.current = [];
        setQueue([]);
        setIndex(0);
        setPlaying(false);
        setLyrics(null);
        // Host: broadcasting the empty queue clears members' controls too (the
        // [queue,index,playing] effect fires on the queue change).
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

  // Load + play whenever the LOCAL current track changes. A silent chorus member
  // has no local audio — skip entirely.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !localCurrent) return;
    if (memberNow()) return; // members don't drive local audio
    audio.src = streamUrl(localCurrent.id);
    audio.play().catch(() => setPlaying(false));
    setPosition(0);
    setLyrics(null);
    api
      .get<Lyrics>(`/api/library/tracks/${localCurrent.id}/lyrics`)
      .then(setLyrics)
      .catch(() => setLyrics(null));
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: localCurrent.title,
        artist: localCurrent.artist?.name ?? "",
        album: localCurrent.album?.title ?? "",
        artwork: [{ src: coverUrl(localCurrent.id), sizes: "512x512", type: "image/jpeg" }],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localCurrent?.id]);

  // For a member, load lyrics for the SHARED current track when it changes.
  const memberTrackId = isChorusMember ? chorus!.queue[chorus!.index]?.id ?? null : null;
  useEffect(() => {
    if (!memberTrackId) return;
    setLyrics(null);
    api
      .get<Lyrics>(`/api/library/tracks/${memberTrackId}/lyrics`)
      .then(setLyrics)
      .catch(() => setLyrics(null));
  }, [memberTrackId]);

  // ---- Chorus sync engine ---------------------------------------------------
  const broadcastChorus = useCallback(() => {
    const c = chorusRef.current;
    if (!c || !c.isHost) return; // only the host publishes truth
    api
      .post("/api/chorus/state", {
        queue: queueRef.current.map((t) => t.id),
        index: indexRef.current,
        positionMs: Math.round((audioRef.current?.currentTime ?? 0) * 1000),
        playing: playingRef.current,
      })
      .catch(() => {});
  }, []);

  const sendCommand = useCallback((patch: ChorusPatch) => {
    api.post("/api/chorus/command", patch).catch(() => {});
  }, []);

  const resolveTracks = useCallback(async (ids: string[], c: ChorusState): Promise<Track[]> => {
    const pool = new Map<string, Track>();
    for (const t of queueRef.current) pool.set(t.id, t);
    for (const t of c.queue) pool.set(t.id, t);
    const missing = ids.filter((id) => !pool.has(id));
    if (missing.length) {
      try {
        const r = await api.get<{ tracks: Track[] }>(
          `/api/library/tracks/by-ids?ids=${missing.join(",")}`,
        );
        for (const t of r.tracks) pool.set(t.id, t);
      } catch {
        /* ignore */
      }
    }
    return ids.map((id) => pool.get(id)).filter((t): t is Track => !!t);
  }, []);

  // Host: apply queued member commands to the real player, then broadcast truth.
  const applyHostCommands = useCallback(
    async (cmds: ChorusPatch[], c: ChorusState) => {
      let tQueue: string[] | undefined;
      let tIndex: number | undefined;
      let tPos: number | undefined;
      let tPlaying: boolean | undefined;
      for (const p of cmds) {
        if (p.queue) tQueue = p.queue;
        if (p.index != null) tIndex = p.index;
        if (p.positionMs != null) tPos = p.positionMs;
        if (p.playing != null) tPlaying = p.playing;
      }
      const audio = audioRef.current;
      const localIds = queueRef.current.map((t) => t.id);
      if (tQueue && tQueue.join(",") !== localIds.join(",")) {
        const resolved = await resolveTracks(tQueue, c);
        const curId = currentIdRef.current;
        // A queue EDIT that keeps the current track (add / play-next / remove
        // upcoming) with no explicit seek or play/pause → update the list only;
        // the current track stays at its index so the <audio> never reloads.
        const keepsCurrent = !!curId && tQueue[indexRef.current] === curId;
        if (resolved.length && keepsCurrent && tPos == null && tPlaying == null) {
          orderRef.current = Array.from({ length: resolved.length }, (_, i) => i);
          setQueue(resolved);
        } else if (resolved.length) {
          orderRef.current = Array.from({ length: resolved.length }, (_, i) => i);
          scrobbled.current.clear();
          pendingSeekRef.current = (tPos ?? 0) / 1000;
          setQueue(resolved);
          setIndex(Math.min(Math.max(tIndex ?? 0, 0), resolved.length - 1));
          if (tPlaying === false) setTimeout(() => audio?.pause(), 100);
        }
      } else if (audio) {
        if (tIndex != null && tIndex !== indexRef.current && tIndex >= 0 && tIndex < queueRef.current.length) {
          pendingSeekRef.current = (tPos ?? 0) / 1000;
          setIndex(tIndex);
        } else if (tPos != null) {
          audio.currentTime = tPos / 1000;
        }
        if (tPlaying != null) {
          if (tPlaying && audio.paused) audio.play().catch(() => {});
          if (!tPlaying && !audio.paused) audio.pause();
        }
      }
      // Broadcast the resulting truth (after refs/audio settle).
      setTimeout(() => broadcastChorus(), 150);
    },
    [broadcastChorus, resolveTracks],
  );

  const onChorusEnded = useCallback(() => {
    const c = chorusRef.current;
    const wasMember = !!c && !c.isHost && !c.isPending;
    chorusLoopRef.current = false;
    chorusRef.current = null;
    setChorus(null);
    if (wasMember) audioRef.current?.pause();
  }, []);

  const applyChorusUpdate = useCallback(
    async (c: ChorusState) => {
      const prev = chorusRef.current;
      const wasMember = !!prev && !prev.isHost && !prev.isPending;
      chorusRef.current = c;
      setChorus(c);
      if (c.isHost) {
        if (c.commands && c.commands.length) await applyHostCommands(c.commands, c);
      } else if (c.isPending) {
        // Awaiting approval — keep our own music playing.
      } else {
        // Approved member — silence local audio and mirror the host.
        const audio = audioRef.current;
        if (!wasMember && audio && !audio.paused) audio.pause();
        const adv = c.playing && c.serverNow ? c.serverNow - c.updatedAt : 0;
        memberBaseMsRef.current = c.positionMs + (adv > 0 ? adv : 0);
        memberBaseAtRef.current = Date.now();
        setMemberPos(memberBaseMsRef.current);
      }
    },
    [applyHostCommands],
  );

  const startChorusLoop = useCallback(() => {
    if (chorusLoopRef.current) return;
    chorusLoopRef.current = true;
    (async () => {
      let backoff = 1000;
      while (chorusLoopRef.current) {
        let c: ChorusState | null;
        const ctrl = new AbortController();
        chorusAbortRef.current = ctrl;
        try {
          c = await api.getSignal<ChorusState | null>(
            `/api/chorus/poll?since=${chorusVersionRef.current}`,
            ctrl.signal,
          );
        } catch {
          if (!chorusLoopRef.current) break;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000); // exponential backoff on errors
          continue;
        }
        backoff = 1000; // reset after a successful poll
        if (!chorusLoopRef.current) break;
        if (!c) {
          onChorusEnded();
          break;
        }
        chorusVersionRef.current = c.version;
        await applyChorusUpdate(c);
      }
    })();
  }, [applyChorusUpdate, onChorusEnded]);

  const stopChorusLoop = useCallback(() => {
    chorusLoopRef.current = false;
    chorusAbortRef.current?.abort();
  }, []);

  // Host: low-frequency truth re-broadcast so members never drift (on top of the
  // instant broadcasts from control events).
  useEffect(() => {
    if (!isChorusHost) return;
    const id = setInterval(() => broadcastChorus(), 5000);
    return () => clearInterval(id);
  }, [isChorusHost, broadcastChorus]);

  // Member: animate the progress bar from the extrapolated position.
  useEffect(() => {
    if (!isChorusMember) return;
    const tick = () => setMemberPos(memberPositionMs());
    tick();
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isChorusMember, memberPositionMs]);

  // Host: broadcast content / play-state changes (covers natural advance + OS keys).
  useEffect(() => {
    if (!chorusRef.current?.isHost) return;
    broadcastChorus();
  }, [queue, index, playing, broadcastChorus]);

  // ---- Playback controls ----------------------------------------------------
  const playQueue = useCallback(
    (tracks: Track[], start = 0) => {
      if (!tracks.length) return;
      if (memberNow()) {
        sendCommand({ queue: tracks.map((t) => t.id), index: start, positionMs: 0, playing: true });
        return;
      }
      // Manually choosing music exits any listen-along session.
      if (listenHostRef.current) {
        restoreAfterCurrentRef.current = false;
        savedSessionRef.current = null;
        setListenHost(null);
      }
      chorusAutoStopRef.current = false;
      scrobbled.current.clear();
      orderRef.current = shuffle
        ? shuffledOrder(tracks.length, start)
        : Array.from({ length: tracks.length }, (_, i) => i);
      setQueue(tracks);
      setIndex(start);
      // Auto-start a chorus whenever fresh playback begins (host), unless already in one.
      if (!chorusRef.current) {
        api
          .post<ChorusState>("/api/chorus/start", {
            mode: "open",
            queue: tracks.map((t) => t.id),
            index: start,
            positionMs: 0,
            playing: true,
          })
          .then((c) => {
            chorusVersionRef.current = c.version;
            chorusRef.current = c;
            setChorus(c);
            startChorusLoop();
          })
          .catch(() => {});
      }
    },
    [shuffle, memberNow, sendCommand, startChorusLoop],
  );

  const toggle = useCallback(() => {
    if (memberNow()) {
      const c = chorusRef.current!;
      sendCommand({ playing: !c.playing, positionMs: memberPositionMs() });
      return;
    }
    const audio = audioRef.current;
    if (!audio || !localCurrent) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, [localCurrent, memberNow, sendCommand, memberPositionMs]);

  const next = useCallback(() => {
    if (memberNow()) {
      const c = chorusRef.current!;
      const n = c.queueIds.length;
      if (n) sendCommand({ index: (c.index + 1) % n, positionMs: 0, playing: true });
      return;
    }
    const target = advance(1, true);
    if (target !== null) setIndex(target);
  }, [advance, memberNow, sendCommand]);

  const prev = useCallback(() => {
    if (memberNow()) {
      const c = chorusRef.current!;
      const n = c.queueIds.length;
      if (!n) return;
      if (memberPositionMs() > 3000) sendCommand({ positionMs: 0 });
      else sendCommand({ index: (c.index - 1 + n) % n, positionMs: 0, playing: true });
      return;
    }
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const target = advance(-1, true);
    if (target !== null) setIndex(target);
  }, [advance, memberNow, sendCommand, memberPositionMs]);

  const seek = useCallback(
    (sec: number) => {
      if (memberNow()) {
        sendCommand({ positionMs: Math.round(sec * 1000) });
        memberBaseMsRef.current = Math.round(sec * 1000); // optimistic
        memberBaseAtRef.current = Date.now();
        setMemberPos(memberBaseMsRef.current);
        return;
      }
      if (audioRef.current) audioRef.current.currentTime = sec;
      broadcastChorus(); // host: seek isn't a queue/index/playing change
    },
    [memberNow, sendCommand, broadcastChorus],
  );

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
  const addToQueue = useCallback(
    (t: Track) => {
      if (memberNow()) {
        const c = chorusRef.current!;
        sendCommand({ queue: [...c.queueIds, t.id], index: c.index });
        return;
      }
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
    },
    [memberNow, sendCommand],
  );

  const playNext = useCallback(
    (t: Track) => {
      if (memberNow()) {
        const c = chorusRef.current!;
        const ids = [...c.queueIds];
        const at = Math.min(Math.max(c.index + 1, 0), ids.length);
        ids.splice(at, 0, t.id);
        sendCommand({ queue: ids, index: c.index });
        return;
      }
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
    },
    [memberNow, sendCommand],
  );

  const removeFromQueue = useCallback(
    (i: number) => {
      if (memberNow()) {
        const c = chorusRef.current!;
        if (i <= c.index || i >= c.queueIds.length) return;
        const ids = [...c.queueIds];
        ids.splice(i, 1);
        sendCommand({ queue: ids, index: c.index });
        return;
      }
      setQueue((q) => {
        if (i < 0 || i >= q.length) return q;
        if (i === indexRef.current) return q; // don't yank the playing track
        const nq = q.filter((_, k) => k !== i);
        orderRef.current = orderRef.current
          .filter((idx) => idx !== i)
          .map((idx) => (idx > i ? idx - 1 : idx));
        if (indexRef.current > i) setIndex((n) => n - 1);
        return nq;
      });
    },
    [memberNow, sendCommand],
  );

  const playAt = useCallback(
    (i: number) => {
      if (memberNow()) {
        const c = chorusRef.current!;
        if (i >= 0 && i < c.queueIds.length) sendCommand({ index: i, positionMs: 0, playing: true });
        return;
      }
      if (i >= 0 && i < queueRef.current.length) setIndex(i);
    },
    [memberNow, sendCommand],
  );

  // --- Presence heartbeat ----------------------------------------------------
  // Post what we're playing every 12s, and immediately on track/play changes. A
  // member advertises the shared (chorus) track.
  useEffect(() => {
    const post = () => {
      if (!tokens.access) return; // not signed in yet
      const member = memberNow();
      const c = chorusRef.current;
      const t = member && c ? c.queue[c.index] ?? null : queueRef.current[indexRef.current];
      api
        .post("/api/social/activity", {
          trackId: t?.id ?? null,
          positionMs: member
            ? memberPositionMs()
            : Math.round((audioRef.current?.currentTime ?? 0) * 1000),
          playing: member && c ? c.playing : playingRef.current,
          listeningTo: listenHostRef.current, // host we're listening-along to (or null)
        })
        .catch(() => {});
    };
    post();
    const id = setInterval(post, 12_000);
    return () => clearInterval(id);
  }, [localCurrent?.id, playing, chorus, memberNow, memberPositionMs]);

  // --- Listen along ----------------------------------------------------------
  const leaveChorus = useCallback(async () => {
    chorusAutoStopRef.current = true;
    const wasMember = memberNow();
    stopChorusLoop();
    await api.post("/api/chorus/leave").catch(() => {});
    chorusRef.current = null;
    setChorus(null);
    if (wasMember) audioRef.current?.pause();
  }, [memberNow, stopChorusLoop]);

  const startListenAlong = useCallback(
    (userId: string, name: string) => {
      // Listen-along is a personal follow — end our own hosted chorus first.
      if (chorusRef.current?.isHost) leaveChorus();
      savedSessionRef.current = {
        queue: queueRef.current,
        index: indexRef.current,
        order: orderRef.current,
      };
      restoreAfterCurrentRef.current = false;
      setListenHost({ id: userId, name });
    },
    [leaveChorus],
  );

  const stopListenAlong = useCallback(() => {
    setListenHost(null);
    // Let the current song finish, then restore the saved queue (handled in onEnd).
    if (savedSessionRef.current && queueRef.current.length) {
      restoreAfterCurrentRef.current = true;
    }
  }, []);

  // Long-poll the host while following: match their track + position + seeks/pauses
  // near-instantly (server holds the request until the host's state changes).
  useEffect(() => {
    if (!listenHost) return;
    let active = true;
    let version = 0;
    const ctrl = new AbortController();
    const applyHostActivity = (act: HostActivity) => {
      if (!act.online) {
        stopListenAlong();
        return;
      }
      if (!act.track || !act.trackId) return;
      const audio = audioRef.current;
      if (!audio) return;
      // Extrapolate using server clocks (skew-free) to "now".
      let targetMs = act.positionMs;
      if (act.playing && act.serverNow && act.updatedAt) {
        targetMs += act.serverNow - new Date(act.updatedAt as number).getTime();
      }
      const targetSec = Math.max(0, targetMs / 1000);
      if (currentIdRef.current !== act.trackId) {
        scrobbled.current.clear();
        orderRef.current = [0];
        setQueue([act.track]);
        setIndex(0);
        const onReady = () => {
          audio.currentTime = Math.max(0, targetSec);
          if (act.playing) audio.play().catch(() => {});
          audio.removeEventListener("loadedmetadata", onReady);
        };
        audio.addEventListener("loadedmetadata", onReady);
      } else {
        if (Math.abs(audio.currentTime - targetSec) > 2) {
          audio.currentTime = targetSec;
        }
        if (act.playing && audio.paused) audio.play().catch(() => {});
        if (!act.playing && !audio.paused) audio.pause();
      }
    };
    (async () => {
      let backoff = 1000;
      while (active && listenHostRef.current === listenHost.id) {
        let act: HostActivity;
        try {
          act = await api.getSignal<HostActivity>(
            `/api/social/activity/${listenHost.id}/poll?since=${version}`,
            ctrl.signal,
          );
        } catch {
          if (!active) break;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000); // exponential backoff on errors
          continue;
        }
        backoff = 1000;
        if (!active || listenHostRef.current !== listenHost.id) break;
        version = act.version ?? 0;
        applyHostActivity(act);
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenHost]);

  // ---- Chorus lifecycle actions ----
  const startChorus = useCallback(
    async (mode: "open" | "ask") => {
      try {
        const ids = queueRef.current.map((t) => t.id);
        const c = await api.post<ChorusState>("/api/chorus/start", {
          mode,
          queue: ids,
          index: indexRef.current,
          positionMs: Math.round((audioRef.current?.currentTime ?? 0) * 1000),
          playing: playingRef.current,
        });
        chorusAutoStopRef.current = false;
        chorusVersionRef.current = c.version;
        chorusRef.current = c;
        setChorus(c);
        startChorusLoop();
      } catch {
        /* ignore */
      }
    },
    [startChorusLoop],
  );

  const setChorusMode = useCallback(async (mode: "open" | "ask") => {
    // The mode change bumps the server version; the long-poll picks it up.
    await api.post("/api/chorus/mode", { mode }).catch(() => {});
  }, []);

  const joinChorus = useCallback(
    async (hostId: string): Promise<string> => {
      const r = await api.post<{ status: string }>("/api/chorus/join", { hostId });
      chorusVersionRef.current = 0; // force an immediate hydrate
      startChorusLoop();
      return r.status;
    },
    [startChorusLoop],
  );

  const approveChorus = useCallback(async (userId: string) => {
    await api.post("/api/chorus/approve", { userId }).catch(() => {});
  }, []);
  const denyChorus = useCallback(async (userId: string) => {
    await api.post("/api/chorus/deny", { userId }).catch(() => {});
  }, []);
  const removeFromChorus = useCallback(async (userId: string) => {
    await api.post("/api/chorus/remove", { userId }).catch(() => {});
  }, []);

  // Browser media-key / lock-screen controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => toggle());
  }, [next, prev, toggle]);

  // Public playback view: a silent member reflects the SHARED (host) state.
  const exposedCurrent = isChorusMember ? chorus!.queue[chorus!.index] ?? null : localCurrent;
  const exposedQueue = isChorusMember ? chorus!.queue : queue;
  const exposedIndex = isChorusMember ? chorus!.index : index;
  const exposedPlaying = isChorusMember ? chorus!.playing : playing;
  const exposedPosition = isChorusMember ? memberPos / 1000 : position;
  const exposedDuration = isChorusMember ? exposedCurrent?.duration ?? 0 : duration;

  return (
    <PlayerContext.Provider
      value={{
        queue: exposedQueue,
        index: exposedIndex,
        current: exposedCurrent,
        playing: exposedPlaying,
        position: exposedPosition,
        duration: exposedDuration,
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
        isChorusMember,
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
