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
import type { Track } from "@/lib/types";

interface PlayerState {
  queue: Track[];
  index: number;
  current: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  /** Play a list of tracks starting at `start`. */
  playQueue: (tracks: Track[], start?: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  coverFor: (t: Track) => string;
}

const PlayerContext = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState(1);
  const scrobbled = useRef<Set<string>>(new Set());

  const current = queue[index] ?? null;

  // Create the audio element once.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;
    const onTime = () => {
      setPosition(audio.currentTime);
      // Scrobble once we're a few seconds in.
      const t = queue[index];
      if (t && audio.currentTime > 5 && !scrobbled.current.has(t.id)) {
        scrobbled.current.add(t.id);
        api.post("/api/favorites/scrobble", { trackId: t.id }).catch(() => {});
      }
    };
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnd = () => setIndex((i) => (i + 1 < queueRef.current.length ? i + 1 : i));
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

  // Keep a ref of the queue for the 'ended' handler.
  const queueRef = useRef<Track[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Load + play whenever the current track changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    audio.src = streamUrl(current.id);
    audio.play().catch(() => setPlaying(false));
    setPosition(0);
    // Media Session (lock-screen / media-key controls in the browser).
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

  const playQueue = useCallback((tracks: Track[], start = 0) => {
    if (!tracks.length) return;
    scrobbled.current.clear();
    setQueue(tracks);
    setIndex(start);
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, [current]);

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, queue.length - 1)), [queue.length]);
  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  const seek = useCallback((sec: number) => {
    if (audioRef.current) audioRef.current.currentTime = sec;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVol(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const coverFor = useCallback((t: Track) => coverUrl(t.id), []);

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
        playQueue,
        toggle,
        next,
        prev,
        seek,
        setVolume,
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
