-- Token revocation: every token carries the user's tokenVersion; bumping it
-- invalidates all outstanding access + refresh tokens for that user.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Per-user privacy controls (default on = today's behaviour).
ALTER TABLE "User" ADD COLUMN "shareActivity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "allowListenAlong" BOOLEAN NOT NULL DEFAULT true;

-- Content-hash dedup + AcoustID/MusicBrainz identity.
ALTER TABLE "Track" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "Track" ADD COLUMN "acoustId" TEXT;
ALTER TABLE "Track" ADD COLUMN "mbRecordingId" TEXT;
CREATE INDEX "Track_contentHash_idx" ON "Track"("contentHash");
