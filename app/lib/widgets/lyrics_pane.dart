import 'package:flutter/material.dart';
import '../player.dart';
import '../theme.dart';

/// Scrolling, time-synced lyrics view for the current track. Tapping a line
/// seeks to it. Falls back to plain lyrics, then a "not found" message.
class LyricsPane extends StatefulWidget {
  final PlayerModel player;
  const LyricsPane({super.key, required this.player});
  @override
  State<LyricsPane> createState() => _LyricsPaneState();
}

class _LyricsPaneState extends State<LyricsPane> {
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
  void dispose() {
    _scroll.dispose();
    super.dispose();
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
