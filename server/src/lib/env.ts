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
  adminPassword: process.env.ADMIN_PASSWORD ?? "admin",
};

export const ACCESS_TOKEN_TTL = "30d";
export const REFRESH_TOKEN_TTL = "365d";
