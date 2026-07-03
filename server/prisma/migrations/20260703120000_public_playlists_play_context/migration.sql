-- Public/curated playlists: a public playlist shows in every user's Home
-- "Curated playlists" section, attributed to its owner.
ALTER TABLE "Playlist" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Playlist_isPublic_idx" ON "Playlist"("isPublic");

-- Playback context: which playlist (if any) a track was played from, so the
-- Recently Played row can collapse a run of plays into the playlist itself.
ALTER TABLE "PlayHistory" ADD COLUMN "playlistId" TEXT;
CREATE INDEX "PlayHistory_playlistId_idx" ON "PlayHistory"("playlistId");
ALTER TABLE "PlayHistory" ADD CONSTRAINT "PlayHistory_playlistId_fkey"
  FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;
