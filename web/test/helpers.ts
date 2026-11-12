// Shared test helpers: an in-memory localStorage (Node has no DOM) and a
// minimal Track factory.
import type { Track } from "../src/lib/types";

export class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
}

/** Install a fresh browser-ish global (window + localStorage). Returns the storage. */
export function installBrowserGlobals(): MemoryStorage {
  const storage = new MemoryStorage();
  const g = globalThis as Record<string, unknown>;
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  // `window` only needs to be defined (prefs check typeof window) and dispatch events.
  if (!("window" in g)) g.window = new EventTarget();
  if (typeof g.CustomEvent !== "function") {
    g.CustomEvent = class<T> extends Event {
      detail: T;
      constructor(type: string, init?: { detail?: T }) {
        super(type);
        this.detail = init?.detail as T;
      }
    };
  }
  return storage;
}

export function track(id: string, over: Partial<Track> = {}): Track {
  return { id, title: id, duration: 0, ...over };
}
