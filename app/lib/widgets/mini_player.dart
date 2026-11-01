import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';
import 'like_button.dart';
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

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      child: CustomPaint(
        // Draw the progress as a stroke that follows the bubble's rounded border,
        // so it curves cleanly around the corners instead of being a flat bar
        // clipped at the bottom edge.
        // Repaints straight off the position notifier: ticks redraw only the ring,
        // without rebuilding the mini-player.
        foregroundPainter: _BubbleProgressPainter(player),
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
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
              child: Row(
                children: [
                  Cover(url: api.trackCoverUrl(track.id), trackId: track.id, size: 42, radius: 8),
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
                  LikeButton(trackId: track.id, size: 20),
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
          ),
        ),
      ),
    );
  }
}

/// Paints the playback progress as a stroke tracing the mini-player's rounded
/// border (radius 14), starting at the top-left and running clockwise, so the
/// progress follows the curve of the bubble.
class _BubbleProgressPainter extends CustomPainter {
  final PlayerModel player;
  _BubbleProgressPainter(this.player) : super(repaint: player.positionTick);

  double get progress {
    final dur = player.duration.inMilliseconds;
    return dur > 0 ? (player.position.inMilliseconds / dur).clamp(0.0, 1.0) : 0.0;
  }

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 2.5;
    const radius = 14.0;
    final r = RRect.fromRectAndRadius(
      (Offset.zero & size).deflate(stroke / 2),
      const Radius.circular(radius - stroke / 2),
    );
    final path = Path()..addRRect(r);
    final bg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = kBorder;
    canvas.drawPath(path, bg);
    final p = progress.clamp(0.0, 1.0);
    if (p <= 0) return;
    final fg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..color = kAccent;
    for (final metric in path.computeMetrics()) {
      canvas.drawPath(metric.extractPath(0, metric.length * p), fg);
    }
  }

  @override
  bool shouldRepaint(covariant _BubbleProgressPainter old) => old.player != player;
}
