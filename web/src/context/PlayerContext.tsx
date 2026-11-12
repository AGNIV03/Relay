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
import {
  api,
  streamUrl,
  coverUrl,
  tokens,
  clock,
  syncClock,
  ApiError,
  ensureMediaToken,
} from "@/lib/api";
import {
  initCast,
  subscribeCast,
  castSnapshot,
  castLoadQueue,
  castJumpTo,
  castSyncUpcoming,
  castPlay,
  castPause,
  castSeek,
  castSetVolume,
  endCastSession,
  requestCastSession,
  type CastItem,
  type CastSnapshot,
  type CastState,
} from "@/lib/cast";
import type { Track, Lyrics, HostActivity, ChorusState, ChorusPatch } from "@/lib/types";
import { normFactor } from "@/lib/loudness";

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

// ---- Playback settings (shared with the settings page via localStorage) ----
/** CustomEvent ({detail: {key, value}}) fired on window after a playback setting
 *  changes in this tab (the `storage` event only reaches other tabs). */
export const SETTINGS_EVENT = "relay-settings";

interface PlaybackSettings {
  autoplay: boolean;
  normalize: boolean;
  fadeSeconds: number;
}

function readSettings(): PlaybackSettings {
  const get = (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const bool = (k: string, def: boolean) => {
    const v = get(k);
    if (v == null) return def;
    return !(v === "false" || v === "0");
  };
  const fade = Number(get("set_fade_seconds") ?? 0);
  return {
    autoplay: bool("set_autoplay", true),
    normalize: bool("set_normalize", true),
    fadeSeconds: Number.isFinite(fade) ? Math.min(12, Math.max(0, fade)) : 0,
  };
}


/** One of the two <audio> elements. The active one plays the current track; the
 *  other preloads the next track (gapless) or fades in over it (crossfade).
 *  Effective element volume = user volume x normalization x fade gain, so the
 *  user-visible volume never changes. */
interface Deck {
  el: HTMLAudioElement;
  track: Track | null;
  norm: number;
  gain: number;
}

// Start preloading the next track this many seconds (plus the fade) before the end.
const PRELOAD_LEAD_SEC = 30;
// Receiver queue window (Chromecast): current + this many upcoming tracks.
const CAST_WINDOW = 25;

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
  // ---- Autoplay (radio after the queue runs out) ----
  autoplay: boolean;
  setAutoplay: (on: boolean) => void;
  /** Whether queue item `i` was added by autoplay. */
  isAutoplay: (i: number) => boolean;
  // ---- Chromecast ----
  castState: CastState;
  casting: boolean;
  castDevice: string | null;
  /** Open the browser's cast device picker (also offers "Stop casting"). */
  requestCast: () => void;
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
  // The ACTIVE audio element (always one of decksRef's two).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const decksRef = useRef<Deck[]>([]);
  const volRef = useRef(1); // user volume (the slider), never normalization/fade
  const settingsRef = useRef<PlaybackSettings>({ autoplay: true, normalize: true, fadeSeconds: 0 });
  const [autoplay, setAutoplayState] = useState(true);
  // Next track preloaded on the inactive deck, and an in-progress crossfade.
  const preloadRef = useRef<{ deck: Deck; trackId: string } | null>(null);
  const fadeRef = useRef<{ out: Deck; inn: Deck; start: number; ms: number; timer: number } | null>(
    null,
  );
  // Track id whose element is already playing when the index catches up (a
  // gapless / crossfade handover), so the load effect doesn't reload it.
  const handoffRef = useRef<string | null>(null);
  const retriedRef = useRef<string | null>(null); // media-error retry, once per load
  // The current play, for the scrobble-completion rule.
  const playRef = useRef<{
    trackId: string;
    startedAt: string;
    listened: number;
    lastPos: number;
    done: boolean;
  } | null>(null);
  // Autoplay: tracks it appended (object identity survives queue edits) and the
  // seed it last fetched for (one fetch per track start).
  const autoplayTracksRef = useRef(new WeakSet<Track>());
  const autoplayFetchRef = useRef<string | null>(null);
  const applyAutoplayRef = useRef<(on: boolean) => void>(() => {});
  // Chromecast.
  const [castSnap, setCastSnap] = useState<CastSnapshot>(() => castSnapshot());
  const castingRef = useRef(false);
  const castFollowIdRef = useRef<string | null>(null); // index moved because the receiver advanced
  const castExpectRef = useRef<{ trackId: string; until: number } | null>(null);
  const lastCastRef = useRef<CastSnapshot | null>(null);
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

  // ---- Audio engine: two decks (gapless preload + crossfade) ----------------
  const deckOf = useCallback(
    (el: HTMLAudioElement | null) => decksRef.current.find((d) => d.el === el) ?? null,
    [],
  );

  const applyVolume = useCallback((d: Deck) => {
    d.el.volume = Math.min(1, Math.max(0, volRef.current * d.norm * d.gain));
  }, []);

  const assignTrack = useCallback(
    (d: Deck, t: Track | null) => {
      d.track = t;
      d.norm = normFactor(t, settingsRef.current.normalize);
      d.gain = 1;
      applyVolume(d);
    },
    [applyVolume],
  );

  const clearDeck = useCallback((d: Deck) => {
    d.el.pause();
    d.el.removeAttribute("src");
    d.el.load();
    d.track = null;
    d.gain = 1;
  }, []);

  // Re-read the playback settings (the settings page writes localStorage).
  const reloadSettings = useCallback(() => {
    const s = readSettings();
    const normChanged = s.normalize !== settingsRef.current.normalize;
    settingsRef.current = s;
    setAutoplayState(s.autoplay);
    if (normChanged) {
      for (const d of decksRef.current) {
        d.norm = normFactor(d.track, s.normalize);
        applyVolume(d);
      }
    }
  }, [applyVolume]);

  // End any crossfade now: silence + unload the outgoing deck, full gain on the new one.
  const finishFade = useCallback(() => {
    const f = fadeRef.current;
    if (!f) return;
    fadeRef.current = null;
    clearInterval(f.timer);
    clearDeck(f.out);
    f.inn.gain = 1;
    applyVolume(f.inn);
  }, [applyVolume, clearDeck]);

  const dropPreload = useCallback(() => {
    const p = preloadRef.current;
    if (!p) return;
    preloadRef.current = null;
    if (p.deck.el !== audioRef.current) clearDeck(p.deck);
  }, [clearDeck]);

  // Apply a pending seek (chorus command / adopt / cast handback) once the
  // element knows its duration; otherwise loadedmetadata applies it.
  const applyPendingSeek = useCallback((el: HTMLAudioElement) => {
    if (pendingSeekRef.current != null && el.readyState >= 1) {
      el.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
  }, []);

  // Load `t` on the active deck (Range-streamed original), optionally at `at` seconds.
  const loadLocal = useCallback(
    (t: Track, at: number, play: boolean) => {
      const audio = audioRef.current;
      const d = deckOf(audio);
      if (!audio || !d) return;
      finishFade();
      assignTrack(d, t);
      retriedRef.current = null;
      if (at > 0) pendingSeekRef.current = at;
      audio.src = streamUrl(t.id);
      if (play) audio.play().catch(() => setPlaying(false));
      else audio.pause();
    },
    [deckOf, finishFade, assignTrack],
  );

  // Make the deck holding the preloaded track active and start it (gapless).
  const swapToPreload = useCallback((): boolean => {
    const p = preloadRef.current;
    const old = deckOf(audioRef.current);
    if (!p || !old || p.deck === old) return false;
    preloadRef.current = null;
    finishFade();
    audioRef.current = p.deck.el;
    p.deck.gain = 1;
    applyVolume(p.deck);
    retriedRef.current = null;
    clearDeck(old);
    applyPendingSeek(p.deck.el);
    p.deck.el.play().catch(() => setPlaying(false));
    setDuration(p.deck.el.duration || p.deck.track?.duration || 0);
    return true;
  }, [deckOf, finishFade, applyVolume, clearDeck, applyPendingSeek]);

  // The track a natural end would move to, or null when there's nothing to
  // preload (repeat-one loops, listen-along follows the host, a member has no
  // audio, the Chromecast runs its own queue, a stopped listen-along restores).
  const naturalNext = useCallback((): number | null => {
    if (restoreAfterCurrentRef.current || listenHostRef.current || castingRef.current) return null;
    if (memberNow() || repeatRef.current === "one") return null;
    return advance(1, repeatRef.current === "all");
  }, [memberNow, advance]);

  const preloadFailedRef = useRef<string | null>(null);
  const preloadInto = useCallback(
    (t: Track) => {
      const other = decksRef.current.find((d) => d.el !== audioRef.current);
      if (!other || preloadFailedRef.current === t.id) return;
      preloadRef.current = { deck: other, trackId: t.id };
      assignTrack(other, t);
      other.el.src = streamUrl(t.id);
      other.el.load();
    },
    [assignTrack],
  );

  // Crossfade into the preloaded track: it starts silent on the other deck and
  // the two swap gain along equal-power curves (cos/sin) over the fade window.
  const startCrossfade = useCallback(
    (target: number, t: Track, remaining: number) => {
      const out = deckOf(audioRef.current);
      const p = preloadRef.current;
      if (!out || !p || p.deck === out) return;
      preloadRef.current = null;
      const inn = p.deck;
      inn.gain = 0;
      applyVolume(inn);
      audioRef.current = inn.el; // the incoming deck is now the player
      retriedRef.current = null;
      inn.el.play().catch(() => {});
      const ms = Math.max(500, Math.min(settingsRef.current.fadeSeconds, remaining) * 1000);
      const timer = window.setInterval(() => {
        const f = fadeRef.current;
        if (!f) return;
        const k = Math.min(1, (performance.now() - f.start) / f.ms);
        f.out.gain = Math.cos((k * Math.PI) / 2);
        f.inn.gain = Math.sin((k * Math.PI) / 2);
        applyVolume(f.out);
        applyVolume(f.inn);
        if (k >= 1) finishFade();
      }, 50);
      fadeRef.current = { out, inn, start: performance.now(), ms, timer };
      setDuration(inn.el.duration || t.duration || 0);
      setPosition(0);
      handoffRef.current = t.id;
      setIndex(target);
    },
    [deckOf, applyVolume, finishFade],
  );

  // Runs on the active deck's timeupdate: preload the next track near the end,
  // and start the crossfade when the fade window opens.
  const transitionTick = useCallback(() => {
    if (fadeRef.current) return;
    const el = audioRef.current;
    if (!el) return;
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const remaining = dur - el.currentTime;
    const fade = settingsRef.current.fadeSeconds;
    if (remaining > fade + PRELOAD_LEAD_SEC) return;
    const target = naturalNext();
    const nextT = target != null ? queueRef.current[target] : null;
    if (target == null || !nextT || target === indexRef.current) {
      if (preloadRef.current) dropPreload();
      return;
    }
    if (preloadRef.current?.trackId !== nextT.id) {
      dropPreload();
      preloadInto(nextT);
      return;
    }
    if (
      fade > 0 &&
      !el.paused &&
      remaining <= fade &&
      dur > fade * 2 &&
      preloadRef.current.deck.el.readyState >= 2
    ) {
      startCrossfade(target, nextT, remaining);
    }
  }, [naturalNext, dropPreload, preloadInto, startCrossfade]);

  // ---- Scrobbling: "now playing" at 5s, completion once per play ----
  const beginPlay = useCallback((t: Track) => {
    playRef.current = {
      trackId: t.id,
      startedAt: new Date().toISOString(),
      listened: 0,
      lastPos: 0,
      done: false,
    };
  }, []);

  const trackProgress = useCallback((t: Track, pos: number, elDuration: number) => {
    if (pos > 5 && !scrobbled.current.has(t.id)) {
      scrobbled.current.add(t.id);
      api
        .post("/api/library/scrobble", {
          trackId: t.id,
          ...(playlistContextRef.current ? { playlistId: playlistContextRef.current } : {}),
        })
        .catch(() => {});
    }
    // Completion: actually-played time (seeks don't count) reaches half the
    // track or 4 minutes, for tracks of at least 30s.
    const pr = playRef.current;
    if (!pr || pr.trackId !== t.id || pr.done) return;
    const d = pos - pr.lastPos;
    if (d > 0 && d < 3) pr.listened += d;
    pr.lastPos = pos;
    const dur = t.duration || (Number.isFinite(elDuration) ? elDuration : 0);
    if (dur >= 30 && (pr.listened >= dur / 2 || pr.listened >= 240)) {
      pr.done = true;
      api
        .post("/api/library/scrobble/complete", { trackId: t.id, startedAt: pr.startedAt })
        .catch(() => {});
    }
  }, []);

  // ---- Autoplay: when the last queued track starts, append radio picks ----
  const maybeAutoplay = useCallback(() => {
    if (!settingsRef.current.autoplay || repeatRef.current !== "off") return;
    if (memberNow() || listenHostRef.current || restoreAfterCurrentRef.current) return;
    const q = queueRef.current;
    const i = indexRef.current;
    const cur = q[i];
    if (!cur || i !== q.length - 1 || autoplayFetchRef.current === cur.id) return;
    autoplayFetchRef.current = cur.id;
    const exclude = [...new Set(q.slice(-100).map((t) => t.id))].join(",");
    api
      .get<Track[] | { tracks: Track[] }>(
        `/api/library/radio?seed=${encodeURIComponent(cur.id)}&exclude=${encodeURIComponent(exclude)}&limit=20`,
      )
      .then((r) => {
        const picks = Array.isArray(r) ? r : r?.tracks ?? [];
        if (!settingsRef.current.autoplay || memberNow() || listenHostRef.current) return;
        if (currentIdRef.current !== cur.id) return; // moved on meanwhile
        const q2 = queueRef.current;
        const have = new Set(q2.map((t) => t.id));
        const add = picks.filter((t) => !have.has(t.id));
        if (!add.length) return;
        for (const t of add) autoplayTracksRef.current.add(t);
        const nq = [...q2, ...add];
        userQRef.current = [...userQRef.current.slice(0, q2.length), ...add.map(() => false)];
        queueRef.current = nq;
        setQueue(nq);
      })
      .catch(() => {});
  }, [memberNow]);

  // Bookkeeping when a track becomes current (fresh load or handover).
  const onTrackStarted = useCallback(
    (t: Track, pos: number) => {
      setPosition(pos);
      loadLyrics(t.id);
      beginPlay(t);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: t.title,
          artist: t.artist?.name ?? "",
          album: t.album?.title ?? "",
          artwork: [{ src: coverUrl(t.id), sizes: "512x512", type: "image/jpeg" }],
        });
      }
      maybeAutoplay();
    },
    [loadLyrics, beginPlay, maybeAutoplay],
  );

  // Create the two audio elements once.
  useEffect(() => {
    reloadSettings();
    void ensureMediaToken(); // startup: media token for stream/cover URLs
    const mk = (): Deck => {
      const el = new Audio();
      el.preload = "auto";
      return { el, track: null, norm: 1, gain: 1 };
    };
    const decks = [mk(), mk()];
    decksRef.current = decks;
    audioRef.current = decks[0].el;
    // Only the active deck drives the UI (the other is preloading / fading out),
    // and nothing local does while a Chromecast plays.
    const isActive = (e: Event) => e.currentTarget === audioRef.current && !castingRef.current;
    const onTime = (e: Event) => {
      if (!isActive(e)) return;
      const audio = audioRef.current!;
      setPosition(audio.currentTime);
      const t = deckOf(audio)?.track ?? queueRef.current[indexRef.current];
      if (t) trackProgress(t, audio.currentTime, audio.duration);
      transitionTick();
    };
    const onMeta = (e: Event) => {
      const audio = audioRef.current;
      if (!audio || e.currentTarget !== audio) return;
      setDuration(audio.duration || 0);
      applyPendingSeek(audio);
    };
    const onEnd = (e: Event) => {
      if (!isActive(e)) return;
      const audio = audioRef.current!;
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
      const restart = () => {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        const t = deckOf(audio)?.track;
        if (t) beginPlay(t);
      };
      if (repeatRef.current === "one") {
        restart();
        return;
      }
      const target = advance(1, repeatRef.current === "all");
      if (target === null) {
        // End of the queue (repeat off): finish, stop, and clear the controls
        // entirely instead of freezing at the last second.
        finishFade();
        dropPreload();
        const d = deckOf(audio);
        if (d) clearDeck(d);
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
      if (target === indexRef.current) {
        restart(); // single-track queue on repeat-all
        return;
      }
      // Gapless: the next track is already buffered on the other deck.
      const nextT = queueRef.current[target];
      if (nextT && preloadRef.current?.trackId === nextT.id && swapToPreload()) {
        handoffRef.current = nextT.id;
        setPosition(0);
      }
      setIndex(target);
    };
    const onPlay = (e: Event) => {
      if (isActive(e)) setPlaying(true);
    };
    const onPause = (e: Event) => {
      if (isActive(e)) setPlaying(false);
    };
    // A failed load: maybe the media token expired or was revoked. Renew it once
    // and reload at the same spot.
    const onError = (e: Event) => {
      const el = e.currentTarget as HTMLAudioElement;
      const d = deckOf(el);
      if (!d?.track || !el.getAttribute("src")) return;
      if (el !== audioRef.current) {
        if (preloadRef.current?.deck === d) {
          preloadFailedRef.current = d.track.id;
          dropPreload();
        }
        return;
      }
      if (castingRef.current) return;
      const id = d.track.id;
      if (retriedRef.current === id) return;
      retriedRef.current = id;
      const at = el.currentTime;
      void ensureMediaToken(true).then(() => {
        if (audioRef.current !== el || d.track?.id !== id) return;
        if (at > 0) pendingSeekRef.current = at;
        el.src = streamUrl(id);
        el.play().catch(() => setPlaying(false));
      });
    };
    for (const d of decks) {
      d.el.addEventListener("timeupdate", onTime);
      d.el.addEventListener("loadedmetadata", onMeta);
      d.el.addEventListener("ended", onEnd);
      d.el.addEventListener("play", onPlay);
      d.el.addEventListener("pause", onPause);
      d.el.addEventListener("error", onError);
    }
    // Settings changed in another tab (storage) or on the settings page (event).
    // Applied live: normalization re-levels both decks now, the fade length is
    // read on the next tick, and an autoplay flip adds / drops the picks.
    const onSettings = () => {
      const before = settingsRef.current.autoplay;
      reloadSettings();
      if (settingsRef.current.autoplay !== before) applyAutoplayRef.current(settingsRef.current.autoplay);
    };
    window.addEventListener("storage", onSettings);
    window.addEventListener(SETTINGS_EVENT, onSettings);
    return () => {
      window.removeEventListener("storage", onSettings);
      window.removeEventListener(SETTINGS_EVENT, onSettings);
      if (fadeRef.current) clearInterval(fadeRef.current.timer);
      fadeRef.current = null;
      preloadRef.current = null;
      for (const d of decks) {
        d.el.pause();
        d.el.removeAttribute("src");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Chromecast -------------------------------------------------------------
  const castItem = useCallback(
    (t: Track): CastItem => ({
      trackId: t.id,
      // Receivers choke on hi-res FLAC: ask for a 320k MP3 transcode.
      url: streamUrl(t.id, { format: "mp3", bitrate: 320 }),
      title: t.title,
      artist: t.artist?.name ?? "",
      album: t.album?.title ?? "",
      cover: coverUrl(t.id),
      duration: t.duration || 0,
    }),
    [],
  );

  // Load the local queue from position `i` onto the receiver.
  const castLoadFrom = useCallback(
    async (i: number, at: number, play: boolean) => {
      await ensureMediaToken();
      const items = queueRef.current.slice(i, i + CAST_WINDOW).map(castItem);
      if (!items.length) return;
      castExpectRef.current = { trackId: items[0].trackId, until: Date.now() + 8000 };
      await castLoadQueue(items, at, play);
    },
    [castItem],
  );

  const adoptingRef = useRef(false);
  useEffect(() => {
    let wasConnected = false;
    void initCast();
    const onConnected = (s: CastSnapshot) => {
      // Members and listen-along followers have no local playback to hand over.
      if (memberNow() || listenHostRef.current) {
        endCastSession();
        return;
      }
      const audio = audioRef.current;
      const cur = queueRef.current[indexRef.current] ?? null;
      const at = audio?.currentTime ?? 0;
      const wasPlaying = !!audio && !audio.paused;
      castingRef.current = true;
      finishFade();
      dropPreload();
      audio?.pause();
      if (cur && s.trackId !== cur.id) void castLoadFrom(indexRef.current, at, wasPlaying);
      setPlaying(wasPlaying);
    };
    const onDisconnected = () => {
      if (!castingRef.current) return;
      castingRef.current = false;
      castExpectRef.current = null;
      castFollowIdRef.current = null;
      const last = lastCastRef.current;
      lastCastRef.current = null;
      const cur = queueRef.current[indexRef.current];
      setPlaying(false);
      if (!cur || memberNow()) return;
      // Carry on locally from where the receiver was.
      const at = last && last.trackId === cur.id ? last.position : 0;
      const resume = !!last && !last.paused;
      loadLocal(cur, at, resume);
      setPosition(at);
      setDuration(cur.duration || 0);
    };
    const unsub = subscribeCast((s) => {
      setCastSnap(s);
      const connected = s.state === "connected";
      if (connected && !wasConnected) {
        wasConnected = true;
        onConnected(s);
      } else if (!connected && wasConnected) {
        wasConnected = false;
        onDisconnected();
        return;
      }
      if (!connected || !castingRef.current) return;
      if (s.trackId && s.playerState !== "IDLE") lastCastRef.current = s;
      setPlaying(!s.paused && s.playerState !== "IDLE");
      // While a command we sent is in flight, ignore stale receiver reports.
      const exp = castExpectRef.current;
      if (exp) {
        if (s.trackId === exp.trackId || Date.now() > exp.until) castExpectRef.current = null;
        else return;
      }
      if (s.trackId && s.trackId !== currentIdRef.current) {
        // The receiver moved on through its queue: follow it locally.
        const q = queueRef.current;
        const i = indexRef.current;
        let idx = q.findIndex((t, k) => k > i && t.id === s.trackId);
        if (idx < 0) idx = q.findIndex((t) => t.id === s.trackId);
        if (idx >= 0) {
          castFollowIdRef.current = s.trackId;
          setIndex(idx);
        } else if (!q.length && !adoptingRef.current) {
          // Rejoined a session that's already playing (e.g. after a reload).
          adoptingRef.current = true;
          const id = s.trackId;
          api
            .get<{ tracks: Track[] }>(`/api/library/tracks/by-ids?ids=${encodeURIComponent(id)}`)
            .then((r) => {
              const t = r.tracks[0];
              if (!t || !castingRef.current || queueRef.current.length) return;
              userQRef.current = [false];
              contextOriginalRef.current = [t];
              castFollowIdRef.current = t.id;
              setQueue([t]);
              setIndex(0);
            })
            .catch(() => {})
            .finally(() => {
              adoptingRef.current = false;
            });
        }
        return;
      }
      const t = queueRef.current[indexRef.current];
      if (t && s.trackId === t.id && s.playerState === "PLAYING") {
        trackProgress(t, s.position, s.duration);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the receiver's upcoming queue in step with local edits (add / remove /
  // reorder / autoplay), without interrupting the current track.
  useEffect(() => {
    if (castSnap.state !== "connected") return;
    const id = setTimeout(() => {
      if (!castingRef.current) return;
      const q = queueRef.current;
      const i = indexRef.current;
      if (!q[i] || castSnapshot().trackId !== q[i].id) return;
      void ensureMediaToken().then(() =>
        castSyncUpcoming(q.slice(i + 1, i + CAST_WINDOW).map(castItem)),
      );
    }, 700);
    return () => clearTimeout(id);
  }, [queue, index, castSnap.state, castSnap.trackId, castItem]);

  // Transport routed to the receiver while casting, else the active deck.
  const posSec = useCallback(
    () => (castingRef.current ? castSnapshot().position : audioRef.current?.currentTime ?? 0),
    [],
  );
  const isPaused = useCallback(
    () => (castingRef.current ? castSnapshot().paused : audioRef.current?.paused ?? true),
    [],
  );
  const doPlay = useCallback(() => {
    if (castingRef.current) castPlay();
    else audioRef.current?.play().catch(() => {});
  }, []);
  const doPause = useCallback(() => {
    if (castingRef.current) castPause();
    else {
      finishFade();
      audioRef.current?.pause();
    }
  }, [finishFade]);
  const doSeek = useCallback(
    (sec: number) => {
      if (castingRef.current) castSeek(sec);
      else if (audioRef.current) {
        finishFade();
        audioRef.current.currentTime = sec;
      }
    },
    [finishFade],
  );

  // Load + play whenever the LOCAL current track changes. A silent chorus member
  // has no local audio — skip entirely. A handover (gapless / crossfade) already
  // has the track playing; while casting, the receiver plays it instead.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !localCurrent) return;
    if (memberNow()) return; // members don't drive local audio
    reloadSettings();
    const handed =
      handoffRef.current === localCurrent.id && deckOf(audio)?.track?.id === localCurrent.id;
    handoffRef.current = null;
    if (castingRef.current && !listenHostRef.current) {
      if (castFollowIdRef.current === localCurrent.id) {
        castFollowIdRef.current = null; // the receiver got here on its own
      } else {
        const at = pendingSeekRef.current ?? 0;
        pendingSeekRef.current = null;
        castExpectRef.current = { trackId: localCurrent.id, until: Date.now() + 8000 };
        if (at > 0 || !castJumpTo(localCurrent.id)) void castLoadFrom(indexRef.current, at, true);
      }
      onTrackStarted(localCurrent, 0);
      return;
    }
    if (!handed) {
      // Skipping to the track that's already buffered reuses that deck.
      const pre = preloadRef.current;
      const reused =
        !!pre && pre.trackId === localCurrent.id && !listenHostRef.current && swapToPreload();
      if (!reused) loadLocal(localCurrent, 0, true);
    }
    onTrackStarted(localCurrent, handed ? audioRef.current?.currentTime ?? 0 : 0);
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
    const positionMs = Math.round(posSec() * 1000);
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
  }, [posSec]);

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
          if (tPlaying === false) setTimeout(() => doPause(), 100);
        }
      } else {
        if (tIndex != null && tIndex !== indexRef.current && tIndex >= 0 && tIndex < queueRef.current.length) {
          pendingSeekRef.current = (tPos ?? 0) / 1000;
          setIndex(tIndex);
        } else if (tPos != null) {
          doSeek(tPos / 1000);
        }
        if (tPlaying != null) {
          if (tPlaying && isPaused()) doPlay();
          if (!tPlaying && !isPaused()) doPause();
        }
      }
      // Broadcast the resulting truth (after refs/audio settle).
      setTimeout(() => broadcastChorus(), 150);
    },
    [broadcastChorus, resolveTracks, doPause, doSeek, doPlay, isPaused],
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
        if (!wasMember) {
          finishFade();
          dropPreload();
          if (castingRef.current) {
            castingRef.current = false; // a member's device plays nothing
            endCastSession();
          }
        }
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
    [applyHostCommands, finishFade, dropPreload],
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
    if (!localCurrent) return;
    if (isPaused()) doPlay();
    else doPause();
  }, [localCurrent, memberNow, sendCommand, memberPositionMs, isPaused, doPlay, doPause]);

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
    if (posSec() > 3) {
      doSeek(0);
      broadcastChorus();
      return;
    }
    const target = advance(-1, true);
    if (target !== null) setIndex(target);
  }, [advance, memberNow, sendCommand, memberPositionMs, posSec, doSeek, broadcastChorus]);

  const seek = useCallback(
    (sec: number) => {
      if (memberNow()) {
        sendCommand({ positionMs: Math.round(sec * 1000) });
        memberBaseMsRef.current = Math.round(sec * 1000); // optimistic
        memberBaseAtRef.current = Date.now();
        setMemberPos(memberBaseMsRef.current);
        return;
      }
      doSeek(sec);
      broadcastChorus(); // host: seek isn't a queue/index/playing change
    },
    [memberNow, sendCommand, broadcastChorus, doSeek],
  );

  // The slider is the user volume; normalization and fades scale each deck
  // underneath it. While casting it drives the receiver's volume instead.
  const setVolume = useCallback(
    (v: number) => {
      v = Math.min(1, Math.max(0, v));
      if (castingRef.current) {
        castSetVolume(v);
        return;
      }
      volRef.current = v;
      setVol(v);
      for (const d of decksRef.current) applyVolume(d);
    },
    [applyVolume],
  );

  // Relative volume/seek used by the keyboard + mouse-wheel shortcuts.
  const nudgeVolume = useCallback(
    (delta: number) => {
      const cur = castingRef.current ? castSnapshot().volume : volRef.current;
      setVolume(Math.min(1, Math.max(0, cur + delta)));
    },
    [setVolume],
  );

  const nudgeSeek = useCallback(
    (deltaSec: number) => {
      const base = memberNow() ? memberPositionMs() / 1000 : posSec();
      const dur = castingRef.current
        ? castSnapshot().duration
        : audioRef.current?.duration ?? 0;
      let target = base + deltaSec;
      if (target < 0) target = 0;
      if (dur > 0 && target > dur) target = dur;
      seek(target);
    },
    [memberNow, memberPositionMs, seek, posSec],
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
    const upcomingAuto: Track[] = []; // autoplay picks stay last, in their own section
    for (let i = idx + 1; i < q.length; i++) {
      if (uq[i]) upcomingUser.push(q[i]);
      else if (autoplayTracksRef.current.has(q[i])) upcomingAuto.push(q[i]);
      else upcomingContext.push(q[i]);
    }
    if (upcomingContext.length > 1) {
      if (on) shuffleInPlace(upcomingContext);
      else {
        const orig = new Map(contextOriginalRef.current.map((t, i) => [t.id, i]));
        upcomingContext.sort((a, b) => (orig.get(a.id) ?? 1e9) - (orig.get(b.id) ?? 1e9));
      }
    }
    const newQ = [...q.slice(0, idx + 1), ...upcomingUser, ...upcomingContext, ...upcomingAuto];
    userQRef.current = [
      ...uq.slice(0, idx + 1),
      ...upcomingUser.map(() => true),
      ...upcomingContext.map(() => false),
      ...upcomingAuto.map(() => false),
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

  const isAutoplay = useCallback(
    (i: number) => !isChorusMember && !!queue[i] && autoplayTracksRef.current.has(queue[i]),
    [isChorusMember, queue],
  );

  // Quick toggle (queue panel). Off drops the upcoming autoplay picks; on fetches
  // some right away if the current track is the last one.
  const setAutoplay = useCallback(
    (on: boolean) => {
      try {
        localStorage.setItem("set_autoplay", on ? "true" : "false");
      } catch {
        /* storage unavailable */
      }
      // Same path as the settings page: the listener re-reads and applies it.
      window.dispatchEvent(
        new CustomEvent(SETTINGS_EVENT, { detail: { key: "set_autoplay", value: on ? "true" : "false" } }),
      );
      if (settingsRef.current.autoplay !== on) {
        // Storage unavailable: apply in memory.
        settingsRef.current = { ...settingsRef.current, autoplay: on };
        setAutoplayState(on);
        applyAutoplayRef.current(on);
      }
    },
    [],
  );

  // Side effects of autoplay turning on/off (queue switch or settings page).
  const applyAutoplay = useCallback(
    (on: boolean) => {
      if (on) {
        autoplayFetchRef.current = null;
        maybeAutoplay();
        return;
      }
      const q = queueRef.current;
      const idx = indexRef.current;
      const keep = q.map((t, i) => i <= idx || !autoplayTracksRef.current.has(t));
      if (keep.every(Boolean)) return;
      const nq = q.filter((_, i) => keep[i]);
      userQRef.current = userQRef.current.filter((_, i) => keep[i]);
      queueRef.current = nq;
      setQueue(nq);
    },
    [maybeAutoplay],
  );
  useEffect(() => {
    applyAutoplayRef.current = applyAutoplay;
  }, [applyAutoplay]);

  const requestCast = useCallback(() => {
    void requestCastSession();
  }, []);

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
        : Math.round(posSec() * 1000);
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
  }, [localCurrent?.id, playing, chorus, memberNow, memberPositionMs, posSec]);

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
      // Following plays on this device: hand any Chromecast back first, and
      // drop any preloaded / fading next track.
      if (castingRef.current) {
        castingRef.current = false;
        endCastSession();
      }
      finishFade();
      dropPreload();
      savedSessionRef.current = {
        queue: queueRef.current,
        index: indexRef.current,
        userQ: userQRef.current,
      };
      restoreAfterCurrentRef.current = false;
      setListenHost({ id: userId, name });
    },
    [leaveChorus, finishFade, dropPreload],
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
          positionMs: Math.round(posSec() * 1000),
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
    [startChorusLoop, posSec],
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
  const casting = castSnap.state === "connected" && !isChorusMember;
  const exposedPosition = isChorusMember ? memberPos / 1000 : casting ? castSnap.position : position;
  const exposedDuration = isChorusMember
    ? exposedCurrent?.duration ?? 0
    : casting
      ? castSnap.duration || exposedCurrent?.duration || 0
      : duration;

  return (
    <PlayerContext.Provider
      value={{
        queue: exposedQueue,
        index: exposedIndex,
        current: exposedCurrent,
        playing: exposedPlaying,
        position: exposedPosition,
        duration: exposedDuration,
        volume: casting ? castSnap.volume : volume,
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
        autoplay,
        setAutoplay,
        isAutoplay,
        castState: castSnap.state,
        casting,
        castDevice: castSnap.deviceName,
        requestCast,
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
