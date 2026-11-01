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
import { api, streamUrl, coverUrl, tokens, clock, syncClock, ApiError } from "@/lib/api";
import type { Track, Lyrics, HostActivity, ChorusState, ChorusPatch } from "@/lib/types";

export type RepeatMode = "off" | "all" | "one";

/** Options for a single `playQueue` call. */
export interface PlayOptions {
  /** Shuffle THIS play only (e.g. a playlist's own Shuffle toggle) without
   *  changing the player's global shuffle. Omitted → follow the global toggle. */
  shuffle?: boolean;
  /** When shuffling: true (default, a tapped track) keeps the start track first
   *  and shuffles the rest; false (a whole-list "Play") randomizes the entire
   *  list, so the first song is random too. */
  anchorStart?: boolean;
  playlistId?: string;
}

// Listen-along drift tolerance: with a measured clock offset the host-position
// estimate is good to a few hundred ms, so smaller drift is corrected.
const DRIFT_SYNCED_SEC = 0.7;
const DRIFT_UNSYNCED_SEC = 2;

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
  /** True while the current track's lyrics are being fetched. */
  lyricsLoading: boolean;
  /** Play a list of tracks starting at `start`. Pass `playlistId` when playing a
   *  playlist so Recently Played can group by playlist. The third argument is
   *  either the legacy `forceShuffle` flag (also turns the global shuffle on) or
   *  per-call `PlayOptions`. */
  playQueue: (
    tracks: Track[],
    start?: number,
    opts?: boolean | PlayOptions,
    playlistId?: string,
  ) => void;
  /** Shuffle a whole list (first song random too) and start playing immediately;
   *  turns the global shuffle on. */
  shuffleAndPlay: (tracks: Track[], playlistId?: string) => void;
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
  /** Add a whole list to the user queue, in order, after the current track and
   *  anything already queued. Starts playing it if nothing is loaded. */
  addAllToQueue: (tracks: Track[]) => void;
  /** Clear what's coming up (the current track keeps playing). `userQueueOnly`
   *  drops just the manually queued songs and lets the context carry on. */
  clearQueue: (opts?: { userQueueOnly?: boolean }) => void;
  /** Insert a track to play right after the current one. */
  playNext: (t: Track) => void;
  /** Remove the track at queue position `i`. */
  removeFromQueue: (i: number) => void;
  /** Reorder an upcoming queue item (drag-to-reorder); both indices after current. */
  moveInQueue: (from: number, to: number) => void;
  /** Jump to queue position `i`. */
  playAt: (i: number) => void;
  /** Whether the upcoming queue item at index `i` was manually queued (vs context). */
  isUserQueued: (i: number) => boolean;
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

/** In-place Fisher–Yates shuffle. */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
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
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const lyricsForRef = useRef<string | null>(null); // track the in-flight lyrics fetch is for
  const scrobbled = useRef<Set<string>>(new Set());
  const playlistContextRef = useRef<string | null>(null); // playlist the queue was started from
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
  // Two-layer queue: `queue` is the real flat play order; userQRef[i] marks
  // whether queue[i] is a manually-queued item ("Play next" / "Add to queue")
  // vs part of the context (playlist/album/songs). contextOriginalRef keeps the
  // context's unshuffled order so toggling shuffle off can restore it.
  const userQRef = useRef<boolean[]>([]);
  const contextOriginalRef = useRef<Track[]>([]);
  // Listen-along: saved session to restore on stop, + "finish current then restore" flag.
  const savedSessionRef = useRef<{ queue: Track[]; index: number; userQ: boolean[] } | null>(null);
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

  // Fetch lyrics for a track. A failed fetch shows "No lyrics found" (empty
  // lyrics) instead of an endless loading state; a late reply for a track we've
  // since skipped is dropped.
  const loadLyrics = useCallback((trackId: string) => {
    lyricsForRef.current = trackId;
    setLyrics(null);
    setLyricsLoading(true);
    api
      .get<Lyrics>(`/api/library/tracks/${trackId}/lyrics`)
      .catch((): Lyrics => ({ synced: null, plain: null }))
      .then((l) => {
        if (lyricsForRef.current !== trackId) return;
        setLyrics(l);
        setLyricsLoading(false);
      });
  }, []);

  // Advance helper shared by manual-next and natural-end. The queue IS the play
  // order, so this is just index ± 1 with optional wrap.
  const advance = useCallback((dir: 1 | -1, loop: boolean): number | null => {
    const n = queueRef.current.length;
    if (n === 0) return null;
    let np = indexRef.current + dir;
    if (np >= n) {
      if (!loop) return null;
      np = 0;
    } else if (np < 0) {
      np = n - 1;
    }
    return np;
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
        api
          .post("/api/library/scrobble", {
            trackId: t.id,
            ...(playlistContextRef.current ? { playlistId: playlistContextRef.current } : {}),
          })
          .catch(() => {});
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
          userQRef.current = saved.userQ;
          const np = saved.index + 1 < saved.queue.length ? saved.index + 1 : 0;
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
        userQRef.current = [];
        contextOriginalRef.current = [];
        setQueue([]);
        setIndex(0);
        setPlaying(false);
        lyricsForRef.current = null;
        setLyrics(null);
        setLyricsLoading(false);
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
    loadLyrics(localCurrent.id);
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
    loadLyrics(memberTrackId);
  }, [memberTrackId, loadLyrics]);

  // ---- Chorus sync engine ---------------------------------------------------
  const broadcastChorus = useCallback(() => {
    const c = chorusRef.current;
    if (!c || !c.isHost) return; // only the host publishes truth
    const positionMs = Math.round((audioRef.current?.currentTime ?? 0) * 1000);
    const atServerMs = clock.serverNow(); // when that position was true (null until synced)
    api
      .post("/api/chorus/state", {
        queue: queueRef.current.map((t) => t.id),
        index: indexRef.current,
        positionMs,
        playing: playingRef.current,
        ...(atServerMs != null ? { atServerMs } : {}),
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
          userQRef.current = new Array(resolved.length).fill(false);
          contextOriginalRef.current = resolved;
          setQueue(resolved);
        } else if (resolved.length) {
          userQRef.current = new Array(resolved.length).fill(false);
          contextOriginalRef.current = resolved;
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
        // Extrapolate from when the host's position was true, using our
        // server-clock estimate when we have one (also covers transit time);
        // otherwise the server's clock at response time.
        const srvNow = clock.serverNow() ?? (c.serverNow > 0 ? c.serverNow : null);
        const adv = c.playing && srvNow != null ? srvNow - c.updatedAt : 0;
        memberBaseMsRef.current = c.positionMs + (adv > 0 ? adv : 0);
        memberBaseAtRef.current = Date.now();
        setMemberPos(memberBaseMsRef.current);
      }
    },
    [applyHostCommands],
  );

  const startChorusLoop = useCallback(() => {
    void syncClock(true); // host stamps + member extrapolation
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
    (tracks: Track[], start = 0, opts?: boolean | PlayOptions, playlistId?: string) => {
      if (!tracks.length) return;
      // `true` is the legacy forceShuffle flag (shuffles AND turns the global
      // toggle on); an options object can override shuffle for this play only.
      const o: PlayOptions = typeof opts === "object" ? opts : {};
      const forceShuffle = opts === true;
      playlistContextRef.current = o.playlistId ?? playlistId ?? null;
      const useShuffle = forceShuffle || (o.shuffle ?? shuffle);
      if (forceShuffle && !shuffle) setShuffle(true);
      start = Math.min(Math.max(start, 0), tracks.length - 1);
      // Build the actual play order. With shuffle on: a tapped track (anchorStart)
      // plays first and the rest follow randomly; a whole-list "Play" randomizes
      // the ENTIRE list so the first song is random too. The queue IS the play order.
      let q: Track[];
      let startIdx: number;
      if (useShuffle && tracks.length > 1) {
        if (o.anchorStart ?? true) {
          const rest = shuffleInPlace(tracks.filter((_, i) => i !== start));
          q = [tracks[start], ...rest];
        } else {
          q = shuffleInPlace([...tracks]);
        }
        startIdx = 0;
      } else {
        q = [...tracks];
        startIdx = start;
      }
      if (memberNow()) {
        // Hand the host a queue already in play order (shuffled if requested).
        sendCommand({ queue: q.map((t) => t.id), index: startIdx, positionMs: 0, playing: true });
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
      // A fresh context fully replaces the previous queue (incl. any manual queue).
      contextOriginalRef.current = [...tracks];
      userQRef.current = new Array(q.length).fill(false);
      setQueue(q);
      setIndex(startIdx);
      // Chorus is opt-in (same as the apps): playback no longer auto-hosts a
      // session; the user starts Chorus explicitly from its control.
    },
    [shuffle, memberNow, sendCommand],
  );

  const shuffleAndPlay = useCallback(
    (tracks: Track[], playlistId?: string) => {
      if (!tracks.length) return;
      setShuffle(true);
      playQueue(tracks, 0, { shuffle: true, anchorStart: false, playlistId });
    },
    [playQueue],
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

  // Relative volume/seek used by the keyboard + mouse-wheel shortcuts.
  const nudgeVolume = useCallback(
    (delta: number) => {
      const cur = audioRef.current?.volume ?? 1;
      setVolume(Math.min(1, Math.max(0, cur + delta)));
    },
    [setVolume],
  );

  const nudgeSeek = useCallback(
    (deltaSec: number) => {
      const base = memberNow() ? memberPositionMs() / 1000 : audioRef.current?.currentTime ?? 0;
      const dur = audioRef.current?.duration ?? 0;
      let target = base + deltaSec;
      if (target < 0) target = 0;
      if (dur > 0 && target > dur) target = dur;
      seek(target);
    },
    [memberNow, memberPositionMs, seek],
  );

  // App-wide keyboard shortcuts (web). Skipped while typing in a field so search
  // boxes keep Space / arrows. Keyed off e.code so it's keyboard-layout-independent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      switch (e.code) {
        case "Space":
          e.preventDefault();
          toggle();
          break;
        case "ArrowUp":
          e.preventDefault();
          nudgeVolume(0.05);
          break;
        case "ArrowDown":
          e.preventDefault();
          nudgeVolume(-0.05);
          break;
        case "ArrowRight":
          e.preventDefault();
          nudgeSeek(10);
          break;
        case "ArrowLeft":
          e.preventDefault();
          nudgeSeek(-10);
          break;
        case "BracketLeft":
          e.preventDefault();
          prev();
          break;
        case "BracketRight":
          e.preventDefault();
          next();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, next, prev, nudgeVolume, nudgeSeek]);

  const toggleRepeat = useCallback(
    () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
    [],
  );

  // Reorder only the UPCOMING CONTEXT (keep the current track + user queue). On:
  // shuffle it; off: restore its original order. Current keeps playing.
  const applyShuffle = useCallback((on: boolean) => {
    const q = queueRef.current;
    const uq = userQRef.current;
    const idx = indexRef.current;
    if (q.length <= 1) return;
    const upcomingUser: Track[] = [];
    const upcomingContext: Track[] = [];
    for (let i = idx + 1; i < q.length; i++) (uq[i] ? upcomingUser : upcomingContext).push(q[i]);
    if (upcomingContext.length > 1) {
      if (on) shuffleInPlace(upcomingContext);
      else {
        const orig = new Map(contextOriginalRef.current.map((t, i) => [t.id, i]));
        upcomingContext.sort((a, b) => (orig.get(a.id) ?? 1e9) - (orig.get(b.id) ?? 1e9));
      }
    }
    const newQ = [...q.slice(0, idx + 1), ...upcomingUser, ...upcomingContext];
    userQRef.current = [
      ...uq.slice(0, idx + 1),
      ...upcomingUser.map(() => true),
      ...upcomingContext.map(() => false),
    ];
    setQueue(newQ);
  }, []);

  const toggleShuffle = useCallback(() => {
    const ns = !shuffle;
    setShuffle(ns);
    applyShuffle(ns);
  }, [shuffle, applyShuffle]);

  const coverFor = useCallback((t: Track) => coverUrl(t.id), []);

  // --- Queue editing ---------------------------------------------------------
  // Add to the user queue: after the current track and any already-queued songs,
  // before the rest of the context.
  const addToQueue = useCallback(
    (t: Track) => {
      if (memberNow()) {
        const c = chorusRef.current!;
        sendCommand({ queue: [...c.queueIds, t.id], index: c.index });
        return;
      }
      setQueue((q) => {
        if (!q.length) {
          userQRef.current = [false];
          contextOriginalRef.current = [t];
          scrobbled.current.clear();
          setIndex(0);
          return [t];
        }
        const uq = userQRef.current;
        let at = indexRef.current + 1;
        while (at < q.length && uq[at]) at++;
        userQRef.current = [...uq.slice(0, at), true, ...uq.slice(at)];
        return [...q.slice(0, at), t, ...q.slice(at)];
      });
    },
    [memberNow, sendCommand],
  );

  // Play next: jump to the front of the user queue (right after the current track).
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
          userQRef.current = [false];
          contextOriginalRef.current = [t];
          scrobbled.current.clear();
          setIndex(0);
          return [t];
        }
        const at = indexRef.current + 1;
        const uq = userQRef.current;
        userQRef.current = [...uq.slice(0, at), true, ...uq.slice(at)];
        return [...q.slice(0, at), t, ...q.slice(at)];
      });
    },
    [memberNow, sendCommand],
  );

  // Add a whole list to the user queue (in order), after the current track and
  // anything already queued. Computed from the refs (not a state updater) so the
  // userQ flags are written exactly once.
  const addAllToQueue = useCallback(
    (tracks: Track[]) => {
      if (!tracks.length) return;
      if (memberNow()) {
        const c = chorusRef.current!;
        sendCommand({ queue: [...c.queueIds, ...tracks.map((t) => t.id)], index: c.index });
        return;
      }
      const q = queueRef.current;
      if (!q.length) {
        playQueue(tracks);
        return;
      }
      const uq = userQRef.current;
      let at = indexRef.current + 1;
      while (at < q.length && uq[at]) at++;
      const nq = [...q.slice(0, at), ...tracks, ...q.slice(at)];
      userQRef.current = [...uq.slice(0, at), ...tracks.map(() => true), ...uq.slice(at)];
      queueRef.current = nq;
      setQueue(nq);
    },
    [memberNow, sendCommand, playQueue],
  );

  // Clear what's coming up; the current track keeps playing. User-queued items
  // always form one contiguous block right after the current track, so both
  // cases are a single range removal.
  const clearQueue = useCallback(
    (opts?: { userQueueOnly?: boolean }) => {
      if (memberNow()) {
        // Members have no separate manual queue; ask the host to drop the upcoming.
        const c = chorusRef.current!;
        const keep = c.queueIds.slice(0, Math.min(Math.max(c.index + 1, 0), c.queueIds.length));
        sendCommand({ queue: keep, index: c.index });
        return;
      }
      const q = queueRef.current;
      const uq = userQRef.current;
      const start = indexRef.current + 1;
      let end = q.length;
      if (opts?.userQueueOnly) {
        end = start;
        while (end < q.length && uq[end]) end++;
      }
      if (end <= start) return;
      const nq = [...q.slice(0, start), ...q.slice(end)];
      userQRef.current = [...uq.slice(0, start), ...uq.slice(end)];
      queueRef.current = nq;
      setQueue(nq);
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
        userQRef.current = userQRef.current.filter((_, k) => k !== i);
        if (indexRef.current > i) setIndex((n) => n - 1);
        return nq;
      });
    },
    [memberNow, sendCommand],
  );

  const moveInQueue = useCallback(
    (from: number, to: number) => {
      if (memberNow()) {
        const c = chorusRef.current!;
        if (from <= c.index || to <= c.index || from >= c.queueIds.length || to >= c.queueIds.length)
          return;
        const ids = [...c.queueIds];
        const [id] = ids.splice(from, 1);
        ids.splice(to, 0, id);
        sendCommand({ queue: ids, index: c.index });
        return;
      }
      setQueue((q) => {
        const cur = indexRef.current;
        if (from <= cur || to <= cur || from >= q.length || to >= q.length || from === to) return q;
        const nq = [...q];
        const [t] = nq.splice(from, 1);
        nq.splice(to, 0, t);
        const uq = [...userQRef.current];
        const [f] = uq.splice(from, 1);
        uq.splice(to, 0, f);
        userQRef.current = uq;
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

  const isUserQueued = useCallback(
    (i: number) => !isChorusMember && !!userQRef.current[i],
    [isChorusMember],
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
      const positionMs = member
        ? memberPositionMs()
        : Math.round((audioRef.current?.currentTime ?? 0) * 1000);
      // Server-clock time at which that position was true (null until synced).
      const atServerMs = clock.serverNow();
      api
        .post("/api/social/activity", {
          trackId: t?.id ?? null,
          positionMs,
          playing: member && c ? c.playing : playingRef.current,
          listeningTo: listenHostRef.current, // host we're listening-along to (or null)
          ...(atServerMs != null ? { atServerMs } : {}),
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
        userQ: userQRef.current,
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
    let detachLoad: (() => void) | null = null; // pending new-track sync listeners

    // Where the host's playback is RIGHT NOW (seconds): their reported position
    // plus the time elapsed since it was true. With a measured clock offset that's
    // (our estimate of server now - updatedAt), which also covers the time the
    // response spent in transit; otherwise the server's clock at response time.
    const hostTargetSec = (act: HostActivity) => {
      let adv = 0;
      if (act.playing && act.updatedAt) {
        const srvNow = clock.serverNow() ?? (act.serverNow && act.serverNow > 0 ? act.serverNow : null);
        if (srvNow != null) adv = srvNow - new Date(act.updatedAt as number).getTime();
      }
      return Math.max(0, act.positionMs + (adv > 0 ? adv : 0)) / 1000;
    };

    const applyHostActivity = (act: HostActivity) => {
      if (!act.online) {
        stopListenAlong();
        return;
      }
      if (!act.track || !act.trackId) return;
      const audio = audioRef.current;
      if (!audio) return;
      if (currentIdRef.current !== act.trackId) {
        detachLoad?.();
        scrobbled.current.clear();
        userQRef.current = [false];
        setQueue([act.track]);
        setIndex(0);
        const trackId = act.trackId;
        const stillFollowing = () => active && currentIdRef.current === trackId;
        // Once metadata is in, jump to a freshly computed target (loading took time).
        const onReady = () => {
          audio.removeEventListener("loadedmetadata", onReady);
          if (!stillFollowing()) return;
          audio.currentTime = hostTargetSec(act);
          if (act.playing) audio.play().catch(() => {});
          else audio.pause();
        };
        // Once audio is actually running, re-seek to cover buffering time.
        const onPlaying = () => {
          audio.removeEventListener("playing", onPlaying);
          if (!stillFollowing()) return;
          const fresh = hostTargetSec(act);
          if (Math.abs(audio.currentTime - fresh) > 0.25) audio.currentTime = fresh;
        };
        audio.addEventListener("loadedmetadata", onReady);
        if (act.playing) audio.addEventListener("playing", onPlaying);
        detachLoad = () => {
          audio.removeEventListener("loadedmetadata", onReady);
          audio.removeEventListener("playing", onPlaying);
          detachLoad = null;
        };
      } else {
        const targetSec = hostTargetSec(act);
        const tolerance = clock.offsetMs != null ? DRIFT_SYNCED_SEC : DRIFT_UNSYNCED_SEC;
        if (Math.abs(audio.currentTime - targetSec) > tolerance) {
          audio.currentTime = targetSec;
        }
        if (act.playing && audio.paused) audio.play().catch(() => {});
        if (!act.playing && !audio.paused) audio.pause();
      }
    };
    (async () => {
      await syncClock(true); // measure the clock offset before the first apply
      let backoff = 1000;
      while (active && listenHostRef.current === listenHost.id) {
        void syncClock(); // cached; re-measures every few minutes
        let act: HostActivity;
        try {
          act = await api.getSignal<HostActivity>(
            `/api/social/activity/${listenHost.id}/poll?since=${version}`,
            ctrl.signal,
          );
        } catch (e) {
          if (!active) break;
          if (e instanceof ApiError && e.status === 403) {
            // They turned off sharing / listen-along: stop following instead of
            // retrying forever.
            if (listenHostRef.current === listenHost.id) stopListenAlong();
            break;
          }
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
      detachLoad?.();
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
        lyricsLoading,
        playQueue,
        shuffleAndPlay,
        toggle,
        next,
        prev,
        seek,
        setVolume,
        toggleRepeat,
        toggleShuffle,
        coverFor,
        addToQueue,
        addAllToQueue,
        clearQueue,
        playNext,
        removeFromQueue,
        moveInQueue,
        playAt,
        isUserQueued,
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
