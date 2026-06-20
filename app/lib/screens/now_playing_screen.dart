import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/like_button.dart';
import '../widgets/squiggly_progress.dart';

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
            tooltip: "Lyrics",
            icon: Icon(LucideIcons.mic2, size: 20, color: _showLyrics ? kAccent : kMuted),
            onPressed: () => setState(() => _showLyrics = !_showLyrics),
          ),
        ],
      ),
      body: track == null
          ? const Center(child: Text("Nothing playing", style: TextStyle(color: kMuted)))
          : Column(
              children: [
                Expanded(
                  child: _showLyrics
                      ? _LyricsPane(player: player)
                      : Center(
                          child: Padding(
                            padding: const EdgeInsets.all(28),
                            child: Cover(url: api.trackCoverUrl(track.id), size: 300, radius: 18),
                          ),
                        ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 28),
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
                      IconButton(
                        iconSize: 24,
                        icon: Icon(LucideIcons.shuffle,
                            color: player.shuffleEnabled ? kAccent : kMuted),
                        onPressed: player.toggleShuffle,
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

class _LyricsPane extends StatefulWidget {
  final PlayerModel player;
  const _LyricsPane({required this.player});
  @override
  State<_LyricsPane> createState() => _LyricsPaneState();
}

class _LyricsPaneState extends State<_LyricsPane> {
  final _scroll = ScrollController();
  int _active = -1;

  List<({double t, String text})> _parse(String lrc) {
    final out = <({double t, String text})>[];
    final re = RegExp(r'\[(\d+):(\d+)(?:\.(\d+))?\]');
    for (final line in lrc.split("\n")) {
      final ms = re.allMatches(line).toList();
      if (ms.isEmpty) continue;
      final text = line.replaceAll(re, "").trim();
      for (final m in ms) {
        final min = int.parse(m.group(1)!);
        final sec = int.parse(m.group(2)!);
        final frac = m.group(3) != null ? double.parse("0.${m.group(3)}") : 0.0;
        out.add((t: min * 60 + sec + frac, text: text));
      }
    }
    out.sort((a, b) => a.t.compareTo(b.t));
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final lyrics = widget.player.lyrics;
    if (lyrics == null) {
      return const Center(child: Text("Loading lyrics…", style: TextStyle(color: kMuted)));
    }
    if (lyrics.synced != null && lyrics.synced!.isNotEmpty) {
      final lines = _parse(lyrics.synced!);
      final pos = widget.player.position.inMilliseconds / 1000.0;
      int active = -1;
      for (int i = 0; i < lines.length; i++) {
        if (pos >= lines[i].t - 0.2) {
          active = i;
        } else {
          break;
        }
      }
      if (active != _active) {
        _active = active;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients && active >= 0) {
            _scroll.animateTo((active * 44.0 - 160).clamp(0, _scroll.position.maxScrollExtent),
                duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
          }
        });
      }
      return ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 30),
        itemCount: lines.length,
        itemBuilder: (_, i) => GestureDetector(
          onTap: () => widget.player.seek(Duration(milliseconds: (lines[i].t * 1000).toInt())),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Text(
              lines[i].text.isEmpty ? "♪" : lines[i].text,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 18,
                fontWeight: i == active ? FontWeight.bold : FontWeight.w500,
                color: i == active ? kAccent : kMuted.withValues(alpha: 0.6),
              ),
            ),
          ),
        ),
      );
    }
    if (lyrics.plain != null && lyrics.plain!.isNotEmpty) {
      return SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Text(lyrics.plain!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
      );
    }
    return const Center(child: Text("No lyrics found", style: TextStyle(color: kMuted)));
  }
}
