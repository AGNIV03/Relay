import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../cast/cast_ui.dart';
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
  static const double _controlIcon = 32; // one size for shuffle / prev / next / repeat

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
          const CastButton(size: 22),
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
                    ValueListenableBuilder<Duration>(
                      valueListenable: player.positionTick,
                      builder: (context, _, _) => Column(children: [
                        SquigglyProgress(
                          position: player.position,
                          duration: player.duration,
                          playing: player.playing,
                          onSeek: player.seek,
                        ),
                        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                          Text(_fmt(player.position),
                              style: const TextStyle(color: kMuted, fontSize: 12)),
                          Text(_fmt(player.duration),
                              style: const TextStyle(color: kMuted, fontSize: 12)),
                        ]),
                      ]),
                    ),
                    const SizedBox(height: 10),
                    if (player.casting)
                      const Padding(
                        padding: EdgeInsets.only(bottom: 6),
                        child: CastingLabel(fontSize: 13),
                      ),
                    // Five controls in equal-width slots. Shuffle, previous, next and
                    // repeat share one icon size; play/pause stays the primary circle.
                    Row(children: [
                      Expanded(
                        child: IconButton(
                          iconSize: _controlIcon,
                          icon: Icon(LucideIcons.shuffle,
                              color: player.shuffleEnabled ? kAccent : kMuted),
                          onPressed: player.toggleShuffle,
                        ),
                      ),
                      Expanded(
                        child: IconButton(
                            iconSize: _controlIcon,
                            icon: const Icon(LucideIcons.skipBack),
                            onPressed: player.previous),
                      ),
                      Expanded(
                        child: Center(
                          child: GestureDetector(
                            onTap: player.toggle,
                            child: Container(
                              width: 64,
                              height: 64,
                              decoration:
                                  const BoxDecoration(color: kAccent, shape: BoxShape.circle),
                              child: Icon(player.playing ? LucideIcons.pause : LucideIcons.play,
                                  size: 28, color: kAccentInk),
                            ),
                          ),
                        ),
                      ),
                      Expanded(
                        child: IconButton(
                            iconSize: _controlIcon,
                            icon: const Icon(LucideIcons.skipForward),
                            onPressed: player.next),
                      ),
                      Expanded(
                        child: IconButton(
                          iconSize: _controlIcon,
                          icon: Icon(
                            player.loopMode == LoopMode.one
                                ? LucideIcons.repeatOne
                                : LucideIcons.repeat,
                            color: player.loopMode == LoopMode.off ? kMuted : kAccent,
                          ),
                          onPressed: player.cycleRepeat,
                        ),
                      ),
                    ]),
                  ]),
                ),
              ],
            ),
    );
  }
}

