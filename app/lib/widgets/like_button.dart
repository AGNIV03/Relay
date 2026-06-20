import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../theme.dart';

/// Heart toggle that adds/removes a track from the user's Liked Songs.
class LikeButton extends StatelessWidget {
  final String trackId;
  final double size;
  const LikeButton({super.key, required this.trackId, this.size = 22});

  @override
  Widget build(BuildContext context) {
    final liked = context.select<AppState, bool>((a) => a.isLiked(trackId));
    return IconButton(
      visualDensity: VisualDensity.compact,
      tooltip: liked ? 'Remove from Liked Songs' : 'Save to Liked Songs',
      icon: Icon(
        LucideIcons.heart,
        fill: liked ? 1 : 0,
        size: size,
        color: liked ? kAccent : kMuted,
      ),
      onPressed: () => context.read<AppState>().toggleLike(trackId),
    );
  }
}
