-- AlterTable
ALTER TABLE "Track" ADD COLUMN "lyricsTranslated" TEXT;
ALTER TABLE "Track" ADD COLUMN "lyricsLang" TEXT;
ALTER TABLE "Track" ADD COLUMN "lyricsTransChecked" BOOLEAN NOT NULL DEFAULT false;

-- Re-check lyrics so the improved "prefer synced" lookup re-runs for existing tracks.
UPDATE "Track" SET "lyricsChecked" = false;
