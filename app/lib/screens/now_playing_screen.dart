import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/like_button.dart';
import '../widgets/lyrics_pane.dart';
import '../widgets/squiggly_progress.dart';
import 'queue_screen.dart';

class NowPlayingScreen extends StatefulWidget {
  final bool showLyrics;
  const NowPlayingScreen({super.key, this.showLyrics = false});
  @override
  State<NowPlayingScreen> createState() => _NowPlayingScreenState();
}

class _NowPlayingScreenState extends State<NowPlayingScreen> {
  late bool _showLyrics = widget.showLyrics;

  String _fmt(Duration d) => "${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}";

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final track = player.current;

    return Scaffold(
      appBar: AppBar(
        title: const Text("Now Playing"),
        actions: [
          IconButton(
            tooltip: "Queue",
            icon: const Icon(LucideIcons.listMusic, size: 20),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const QueueScreen()),
            ),
          ),
        ],
      ),
      body: track == null
          ? const Center(child: Text("Nothing playing", style: TextStyle(color: kMuted)))
          : Column(
              children: [
                Expanded(
                  // Gestures on the artwork: swipe down opens lyrics, swipe left /
                  // right skip to the next / previous track. While lyrics show, the
                  // pane scrolls freely; the lyrics button toggles back to the art.
                  child: _showLyrics
                      ? LyricsPane(player: player)
                      : GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onHorizontalDragEnd: (d) {
                            final v = d.primaryVelocity ?? 0;
                            if (v <= -150) {
                              player.next();
                            } else if (v >= 150) {
                              player.previous();
                            }
                          },
                          onVerticalDragEnd: (d) {
                            if ((d.primaryVelocity ?? 0) >= 150) {
                              setState(() => _showLyrics = true);
                            }
                          },
                          child: Center(
                            child: Padding(
                              padding: const EdgeInsets.all(28),
                              child: Cover(
                                  url: api.trackCoverUrl(track.id),
                                  trackId: track.id,
                                  size: 300,
                                  radius: 18),
                            ),
                          ),
                        ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(24, 0, 24, 24 + MediaQuery.of(context).padding.bottom),
                  child: Column(children: [
                    Row(children: [
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(track.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 21, fontWeight: FontWeight.bold)),
                          const SizedBox(height: 4),
                          Text(track.artistName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(color: kMuted, fontSize: 15)),
                        ]),
                      ),
                      IconButton(
                        tooltip: "Lyrics",
                        icon: Icon(LucideIcons.lyrics, size: 24, color: _showLyrics ? kAccent : kMuted),
                        onPressed: () => setState(() => _showLyrics = !_showLyrics),
                      ),
                      LikeButton(trackId: track.id, size: 26),
                    ]),
                    const SizedBox(height: 14),
                    SquigglyProgress(
                      position: player.position,
                      duration: player.duration,
                      playing: player.playing,
                      onSeek: player.seek,
                    ),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      Text(_fmt(player.position), style: const TextStyle(color: kMuted, fontSize: 12)),
                      Text(_fmt(player.duration), style: const TextStyle(color: kMuted, fontSize: 12)),
                    ]),
                    const SizedBox(height: 10),
                    Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      // Shuffle toggle with an unmistakable on/off look: ON shows a
                      // filled cyan circle with a dark icon; OFF is just a muted icon.
                      GestureDetector(
                        onTap: player.toggleShuffle,
                        child: Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(
                            color: player.shuffleEnabled ? kAccent : Colors.transparent,
                            shape: BoxShape.circle,
                          ),
                          child: Icon(LucideIcons.shuffle,
                              size: 22,
                              color: player.shuffleEnabled ? kAccentInk : kMuted),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(iconSize: 34, icon: const Icon(LucideIcons.skipBack), onPressed: player.previous),
                      const SizedBox(width: 12),
                      GestureDetector(
                        onTap: player.toggle,
                        child: Container(
                          width: 64,
                          height: 64,
                          decoration: const BoxDecoration(color: kAccent, shape: BoxShape.circle),
                          child: Icon(player.playing ? LucideIcons.pause : LucideIcons.play,
                              size: 28, color: kAccentInk),
                        ),
                      ),
                      const SizedBox(width: 12),
                      IconButton(iconSize: 34, icon: const Icon(LucideIcons.skipForward), onPressed: player.next),
                      const SizedBox(width: 8),
                      IconButton(
                        iconSize: 24,
                        icon: Icon(
                          player.loopMode == LoopMode.one ? LucideIcons.repeatOne : LucideIcons.repeat,
                          color: player.loopMode == LoopMode.off ? kMuted : kAccent,
                        ),
                        onPressed: player.cycleRepeat,
                      ),
                    ]),
                  ]),
                ),
              ],
            ),
    );
  }
}

