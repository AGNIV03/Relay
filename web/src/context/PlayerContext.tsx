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
import { api, streamUrl, coverUrl } from "@/lib/api";
import type { Track, Lyrics } from "@/lib/types";

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

  const current = queue[index] ?? null;

  // Refs the (once-registered) audio event handlers read from.
  const queueRef = useRef<Track[]>([]);
  const indexRef = useRef(0);
  const repeatRef = useRef<RepeatMode>("off");
  const orderRef = useRef<number[]>([]); // playback order: positions -> queue index
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

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
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnd = () => {
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
