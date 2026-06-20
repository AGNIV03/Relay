import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';
import '../screens/now_playing_screen.dart';

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

    return Material(
      color: kPanel,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const NowPlayingScreen()),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            LinearProgressIndicator(
              value: progress,
              minHeight: 2,
              backgroundColor: kPanel2,
              color: kAccent2,
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  Cover(url: api.trackCoverUrl(track.id), size: 44),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(track.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w500)),
                        Text(track.artistName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: kMuted, fontSize: 12)),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_previous),
                    onPressed: player.previous,
                  ),
                  IconButton(
                    icon: Icon(player.playing ? Icons.pause : Icons.play_arrow),
                    onPressed: player.toggle,
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_next),
                    onPressed: player.next,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
