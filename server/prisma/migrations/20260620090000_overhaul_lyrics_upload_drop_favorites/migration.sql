-- DropForeignKey
ALTER TABLE "Favorite" DROP CONSTRAINT "Favorite_userId_fkey";

-- DropForeignKey
ALTER TABLE "Favorite" DROP CONSTRAINT "Favorite_trackId_fkey";

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "lyricsChecked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lyricsPlain" TEXT,
ADD COLUMN     "lyricsSynced" TEXT;

-- DropTable
DROP TABLE "Favorite";

-- CreateIndex
CREATE INDEX "PlayHistory_userId_trackId_idx" ON "PlayHistory"("userId", "trackId");

