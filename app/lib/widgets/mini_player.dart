import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';
import '../screens/now_playing_screen.dart';

/// Floating "bubble" player pinned just above the bottom nav on every page.
class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final track = player.current;
    if (track == null) return const SizedBox.shrink();

    final dur = player.duration.inMilliseconds;
    final pos = player.position.inMilliseconds;
    final progress = dur > 0 ? (pos / dur).clamp(0.0, 1.0) : 0.0;

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      child: Material(
        color: kPanel2,
        borderRadius: BorderRadius.circular(14),
        elevation: 8,
        shadowColor: Colors.black54,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const NowPlayingScreen()),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
                child: Row(
                  children: [
                    Cover(url: api.trackCoverUrl(track.id), size: 42, radius: 8),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(track.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                          Text(track.artistName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(color: kMuted, fontSize: 11.5)),
                        ],
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(LucideIcons.skipBack, size: 20),
                      onPressed: player.previous,
                    ),
                    GestureDetector(
                      onTap: player.toggle,
                      child: Container(
                        width: 38,
                        height: 38,
                        decoration: const BoxDecoration(color: kAccent, shape: BoxShape.circle),
                        child: Icon(player.playing ? LucideIcons.pause : LucideIcons.play,
                            size: 18, color: kAccentInk),
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(LucideIcons.skipForward, size: 20),
                      onPressed: player.next,
                    ),
                  ],
                ),
              ),
              ClipRRect(
                borderRadius: const BorderRadius.vertical(bottom: Radius.circular(14)),
                child: LinearProgressIndicator(
                  value: progress,
                  minHeight: 2.5,
                  backgroundColor: kBorder,
                  color: kAccent,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
