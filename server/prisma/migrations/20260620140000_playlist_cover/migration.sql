-- AlterTable
ALTER TABLE "Playlist" ADD COLUMN "coverPath" TEXT;
ALTER TABLE "Playlist" ADD COLUMN "coverCustom" BOOLEAN NOT NULL DEFAULT false;
