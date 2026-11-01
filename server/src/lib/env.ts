// Central, validated access to environment configuration.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: required("JWT_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  // Folder that holds the audio library (read-only to the server).
  musicPath: process.env.MUSIC_PATH ?? process.env.MUSIC_DIR ?? "./music",
  // Writable folder for extracted cover art and other derived data.
  dataPath: process.env.DATA_PATH ?? "./data",
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  // `||` so an empty ADMIN_PASSWORD= (as in .env.example) falls back too; the
  // fallback is refused in production by bootstrap's weak-password check.
  adminPassword: process.env.ADMIN_PASSWORD || "admin",
  // Opt-in auto-tagging: an AcoustID application key (https://acoustid.org/new-application).
  // Unset = disabled; when set, audio fingerprints + durations are sent to
  // AcoustID (and MusicBrainz metadata comes back) to fill/fix track tags.
  acoustIdKey: process.env.ACOUSTID_API_KEY ?? "",
};

export const isProduction = process.env.NODE_ENV === "production";

/** True for the example/placeholder values shipped in .env.example. */
export function isPlaceholderSecret(v: string): boolean {
  return v.toLowerCase().includes("change-me");
}

// A short or copied-from-the-example JWT secret lets anyone forge tokens (incl.
// admin ones). Refuse to boot with one in production; just warn in dev.
if (env.jwtSecret.length < 32 || isPlaceholderSecret(env.jwtSecret)) {
  const msg =
    "JWT_SECRET is too short (< 32 chars) or still a placeholder value. Generate one with: " +
    `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`;
  if (isProduction) throw new Error(`Refusing to start: ${msg}`);
  console.warn(`[env] WARNING: ${msg}`);
}

// Token lifetimes are deliberately long: the apps embed the access token in
// queued stream URLs (?token=), which must keep working for a whole listening
// session/offline queue. Revocation is handled by User.tokenVersion (checked on
// every request in requireAuth), so a leaked or old token can be killed via
// password change / "sign out everywhere" / role change despite the long TTL.
export const ACCESS_TOKEN_TTL = "30d";
export const REFRESH_TOKEN_TTL = "365d";
