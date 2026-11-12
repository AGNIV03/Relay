// Google Cast (Chromecast) web sender. Wraps the Cast Web Sender SDK (loaded on
// demand, Chromium only) behind a tiny API the player uses: connection state, a
// snapshot of the receiver's playback, and queue / transport commands. Audio is
// played by the Default Media Receiver straight from our stream URLs.
/* eslint-disable @typescript-eslint/no-explicit-any */

const SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

/** Where casting stands: no SDK / browser support, no devices on the network,
 *  devices available, connecting, or connected. */
export type CastState = "unavailable" | "no-devices" | "available" | "connecting" | "connected";

/** One track as the receiver should play it. */
export interface CastItem {
  trackId: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
}

/** What the receiver is doing right now. */
export interface CastSnapshot {
  state: CastState;
  deviceName: string | null;
  trackId: string | null;
  position: number;
  duration: number;
  paused: boolean;
  /** IDLE / PLAYING / PAUSED / BUFFERING. */
  playerState: string;
  volume: number;
  /** True once the receiver has finished the whole queue (idle, reason FINISHED). */
  finished: boolean;
}

type Listener = (s: CastSnapshot) => void;

const w = (): any => (typeof window === "undefined" ? undefined : (window as any));

let loadPromise: Promise<boolean> | null = null;
let player: any = null;
let controller: any = null;
const listeners = new Set<Listener>();
let snap: CastSnapshot = {
  state: "unavailable",
  deviceName: null,
  trackId: null,
  position: 0,
  duration: 0,
  paused: true,
  playerState: "IDLE",
  volume: 1,
  finished: false,
};

/** The Cast sender only works in Chromium browsers (Chrome, Edge, Opera, ...). */
export function castSupported(): boolean {
  const win = w();
  if (!win || typeof navigator === "undefined") return false;
  const brands: { brand: string }[] | undefined = (navigator as any).userAgentData?.brands;
  if (brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))) return true;
  const ua = navigator.userAgent;
  return /Chrome\/|Chromium\//.test(ua) && !/Firefox|FxiOS/.test(ua) && !!win.chrome;
}

function emit(patch: Partial<CastSnapshot>) {
  snap = { ...snap, ...patch };
  for (const l of listeners) l(snap);
}

/** Subscribe to state/playback changes. Returns an unsubscribe function. */
export function subscribeCast(l: Listener): () => void {
  listeners.add(l);
  l(snap);
  return () => listeners.delete(l);
}

export function castSnapshot(): CastSnapshot {
  return snap;
}

/** The track id a receiver item is playing (customData, else parsed from the URL). */
function trackIdOf(mediaInfo: any): string | null {
  if (!mediaInfo) return null;
  const id = mediaInfo.customData?.trackId;
  if (typeof id === "string") return id;
  const url: string = mediaInfo.contentUrl || mediaInfo.contentId || "";
  const m = /\/api\/stream\/([^/?]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

function mapState(s: string): CastState {
  switch (s) {
    case "NO_DEVICES_AVAILABLE":
      return "no-devices";
    case "NOT_CONNECTED":
      return "available";
    case "CONNECTING":
      return "connecting";
    case "CONNECTED":
      return "connected";
    default:
      return "unavailable";
  }
}

function session(): any {
  return w()?.cast?.framework?.CastContext.getInstance().getCurrentSession() ?? null;
}

function readPlayer() {
  if (!player) return;
  const ms = session()?.getMediaSession?.();
  emit({
    trackId: trackIdOf(player.mediaInfo),
    position: Number(player.currentTime) || 0,
    duration: Number(player.duration) || Number(player.mediaInfo?.duration) || 0,
    paused: !!player.isPaused,
    playerState: String(player.playerState ?? "IDLE"),
    volume: typeof player.volumeLevel === "number" ? player.volumeLevel : snap.volume,
    finished: player.playerState === "IDLE" && ms?.idleReason === "FINISHED",
  });
}

function setup(): boolean {
  const win = w();
  const fw = win?.cast?.framework;
  const cc = win?.chrome?.cast;
  if (!fw || !cc) return false;
  const ctx = fw.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: cc.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: cc.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  ctx.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, (e: any) => {
    const st = mapState(e.castState);
    emit({
      state: st,
      deviceName: st === "connected" ? session()?.getCastDevice?.()?.friendlyName ?? null : null,
    });
  });
  player = new fw.RemotePlayer();
  controller = new fw.RemotePlayerController(player);
  controller.addEventListener(fw.RemotePlayerEventType.ANY_CHANGE, () => readPlayer());
  const st = mapState(ctx.getCastState());
  emit({
    state: st,
    deviceName: st === "connected" ? session()?.getCastDevice?.()?.friendlyName ?? null : null,
  });
  return true;
}

/** Load the SDK (once) and initialise the cast context. Resolves false in
 *  browsers without Cast support or when the SDK can't load. */
export function initCast(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  if (!castSupported()) return (loadPromise = Promise.resolve(false));
  loadPromise = new Promise<boolean>((resolve) => {
    const win = w();
    if (win.cast?.framework) {
      resolve(setup());
      return;
    }
    const timer = setTimeout(() => resolve(false), 15000);
    win.__onGCastApiAvailable = (ok: boolean) => {
      clearTimeout(timer);
      try {
        resolve(ok ? setup() : false);
      } catch {
        resolve(false);
      }
    };
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}

/** Open the browser's device picker (it also offers "Stop casting"). */
export async function requestCastSession(): Promise<void> {
  const ctx = w()?.cast?.framework?.CastContext.getInstance();
  if (!ctx) return;
  try {
    await ctx.requestSession();
  } catch {
    /* picker dismissed */
  }
}

export function endCastSession() {
  session()?.endSession(true);
}

function mediaInfoFor(it: CastItem): any {
  const cm = w().chrome.cast.media;
  const info = new cm.MediaInfo(it.url, "audio/mpeg");
  info.contentUrl = it.url;
  info.streamType = cm.StreamType.BUFFERED;
  if (it.duration > 0) info.duration = it.duration;
  const md = new cm.MusicTrackMediaMetadata();
  md.title = it.title;
  md.artist = it.artist;
  md.albumName = it.album;
  md.images = [new (w().chrome.cast.Image)(it.cover)];
  info.metadata = md;
  info.customData = { trackId: it.trackId };
  return info;
}

function queueItemFor(it: CastItem): any {
  const item = new (w().chrome.cast.media.QueueItem)(mediaInfoFor(it));
  item.autoplay = true;
  item.preloadTime = 10;
  item.customData = { trackId: it.trackId };
  return item;
}

/** Replace whatever the receiver plays with `items`, starting at item 0 at
 *  `startTime` seconds. */
export async function castLoadQueue(items: CastItem[], startTime: number, autoplay: boolean) {
  const s = session();
  if (!s || !items.length) return;
  const cm = w().chrome.cast.media;
  emit({ finished: false });
  if (cm.QueueData) {
    const req = new cm.LoadRequest(mediaInfoFor(items[0]));
    req.autoplay = autoplay;
    req.currentTime = Math.max(0, startTime);
    const qd = new cm.QueueData();
    qd.items = items.map(queueItemFor);
    qd.startIndex = 0;
    qd.repeatMode = cm.RepeatMode.OFF;
    req.queueData = qd;
    try {
      await s.loadMedia(req);
      return;
    } catch {
      /* fall through to the single-item load */
    }
  }
  const req = new cm.LoadRequest(mediaInfoFor(items[0]));
  req.autoplay = autoplay;
  req.currentTime = Math.max(0, startTime);
  await s.loadMedia(req).catch(() => {});
}

/** Track ids queued on the receiver after the current item. */
function receiverQueue(): { media: any; currentIdx: number; items: any[] } | null {
  const media = session()?.getMediaSession?.();
  if (!media || !Array.isArray(media.items)) return null;
  const currentIdx = media.items.findIndex((i: any) => i.itemId === media.currentItemId);
  return { media, currentIdx, items: media.items };
}

/** Jump to the receiver queue item playing `trackId` (after/around the current
 *  one). Returns false if the receiver doesn't hold it. */
export function castJumpTo(trackId: string): boolean {
  const q = receiverQueue();
  if (!q) return false;
  const item = q.items.find((i: any, k: number) => k !== q.currentIdx && trackIdOf(i.media) === trackId);
  if (!item) return false;
  q.media.queueJumpToItem(item.itemId, () => {}, () => {});
  return true;
}

/** Make the receiver's upcoming queue (after the current item) equal `upcoming`,
 *  without interrupting the current track. */
export function castSyncUpcoming(upcoming: CastItem[]) {
  const q = receiverQueue();
  if (!q || q.currentIdx < 0) return;
  const after = q.items.slice(q.currentIdx + 1);
  const have = after.map((i: any) => trackIdOf(i.media));
  const want = upcoming.map((u) => u.trackId);
  if (have.join(",") === want.join(",")) return;
  const cm = w().chrome.cast.media;
  const insert = (items: CastItem[]) => {
    if (!items.length) return;
    q.media.queueInsertItems(
      new cm.QueueInsertItemsRequest(items.map(queueItemFor)),
      () => {},
      () => {},
    );
  };
  // Common case (autoplay / add to queue / the window moving on): the receiver
  // already holds a prefix of what we want, so just append the rest.
  if (have.length < want.length && have.every((id: string | null, k: number) => id === want[k])) {
    insert(upcoming.slice(have.length));
    return;
  }
  if (after.length) {
    q.media.queueRemoveItems(
      new cm.QueueRemoveItemsRequest(after.map((i: any) => i.itemId)),
      () => insert(upcoming),
      () => {},
    );
  } else {
    insert(upcoming);
  }
}

export function castPlay() {
  if (player && controller && player.isPaused) controller.playOrPause();
}

export function castPause() {
  if (player && controller && !player.isPaused) controller.playOrPause();
}

export function castSeek(sec: number) {
  if (!player || !controller) return;
  player.currentTime = Math.max(0, sec);
  controller.seek();
  emit({ position: Math.max(0, sec) }); // optimistic, the receiver confirms
}

export function castSetVolume(v: number) {
  if (!player || !controller) return;
  player.volumeLevel = Math.min(1, Math.max(0, v));
  controller.setVolumeLevel();
  emit({ volume: player.volumeLevel });
}
