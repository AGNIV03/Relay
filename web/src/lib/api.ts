// Minimal typed API client with JWT storage + automatic refresh.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const ACCESS_KEY = "stream_access";
const REFRESH_KEY = "stream_refresh";

export const tokens = {
  get access() {
    return typeof window === "undefined" ? null : localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return typeof window === "undefined" ? null : localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh?: string) {
    localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function refreshAccessToken(): Promise<boolean> {
  const refresh = tokens.refresh;
  if (!refresh) return false;
  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  tokens.set(data.accessToken, data.refreshToken);
  return true;
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const access = tokens.access;
  if (access) headers.set("Authorization", `Bearer ${access}`);

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (res.status === 401 && retry && (await refreshAccessToken())) {
    return request<T>(path, options, false);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  /** GET that can be cancelled (used for long-poll loops). */
  getSignal: <T>(path: string, signal: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Upload audio files (multipart) with progress. Originals are preserved (no transcode). */
export function uploadFiles(
  files: File[],
  onProgress?: (pct: number) => void,
): Promise<{ added: number; failed: number; duplicates?: number; addedNames: string[]; failedNames: string[] }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/library/upload`);
    const access = tokens.access;
    if (access) xhr.setRequestHeader("Authorization", `Bearer ${access}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Bad response"));
        }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error ?? msg;
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}

/** Files at/above this size are uploaded in chunks (Cloudflare caps a single
 *  request body at ~100MB). */
export const CHUNK_THRESHOLD = 90 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024 * 1024;

interface UploadResult {
  added: number;
  failed: number;
  duplicates?: number;
  addedNames: string[];
  failedNames: string[];
}

/** Upload one large file in chunks (each well under the CDN cap), then finalize. */
export async function uploadFileChunked(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const auth = (): HeadersInit => (tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {});

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_SIZE;
    const blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    const res = await fetch(
      `${API_URL}/api/library/upload/chunk?uploadId=${uploadId}&index=${i}`,
      { method: "POST", headers: auth(), body: blob },
    );
    if (!res.ok) throw new Error(`Upload failed (chunk ${i + 1}/${total})`);
    onProgress?.(Math.round(((i + 1) / total) * 100));
  }

  const res = await fetch(`${API_URL}/api/library/upload/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth() },
    body: JSON.stringify({ uploadId, filename: file.name }),
  });
  if (!res.ok) {
    let msg = "Upload failed";
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

/** Build an authenticated media URL for <audio>/<img> (token in query). */
export function streamUrl(trackId: string, opts?: { format?: string; bitrate?: number }) {
  const params = new URLSearchParams({ token: tokens.access ?? "" });
  if (opts?.format) params.set("format", opts.format);
  if (opts?.bitrate) params.set("bitrate", String(opts.bitrate));
  return `${API_URL}/api/stream/${trackId}?${params.toString()}`;
}

export function coverUrl(trackId: string) {
  return `${API_URL}/api/stream/${trackId}/cover?token=${tokens.access ?? ""}`;
}

/** Playlist cover (auto collage or custom). `v` busts the cache after a change. */
export function playlistCoverUrl(id: string, v?: number | string) {
  const ver = v != null ? `&v=${v}` : "";
  return `${API_URL}/api/playlists/${id}/cover?token=${tokens.access ?? ""}${ver}`;
}

/** Upload a custom playlist cover image (multipart). */
export function uploadPlaylistCover(id: string, file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("cover", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/playlists/${id}/cover`);
    const access = tokens.access;
    if (access) xhr.setRequestHeader("Authorization", `Bearer ${access}`);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Cover upload failed"));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  });
}

export function albumCoverUrl(albumId: string) {
  return `${API_URL}/api/stream/album/${albumId}/cover?token=${tokens.access ?? ""}`;
}

export { ApiError };
