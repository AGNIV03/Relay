"use client";

import { Heart } from "lucide-react";
import { useLiked } from "@/context/LikedContext";

export function LikeButton({ trackId, size = 16 }: { trackId: string; size?: number }) {
  const { isLiked, toggleLike } = useLiked();
  const liked = isLiked(trackId);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleLike(trackId);
      }}
      title={liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
      className={`transition hover:scale-110 ${
        liked ? "text-[var(--accent)]" : "text-[var(--muted)] hover:text-white"
      }`}
    >
      <Heart size={size} fill={liked ? "currentColor" : "none"} />
    </button>
  );
}
