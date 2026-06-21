import 'package:flutter/material.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';

const _langNames = {
  'ja': 'Japanese', 'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian',
  'ko': 'Korean', 'zh': 'Chinese', 'pt': 'Portuguese', 'ru': 'Russian', 'hi': 'Hindi',
  'ar': 'Arabic', 'nl': 'Dutch', 'sv': 'Swedish', 'pl': 'Polish', 'tr': 'Turkish',
};

/// Scrolling, time-synced lyrics for the current track (tap a line to seek).
/// When a translation exists it's shown line-by-line beneath each original line
/// (the translation is downloaded + stored with the song, so it's instant).
class LyricsPane extends StatefulWidget {
  final PlayerModel player;
  const LyricsPane({super.key, required this.player});
  @override
  State<LyricsPane> createState() => _LyricsPaneState();
}

class _LyricsPaneState extends State<LyricsPane> {
  final _scroll = ScrollController();
  int _active = -1;
  String? _lastTrackId;
  bool _showTrans = true; // default on whenever a translation exists

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

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

  /// Map translation lines (non-empty originals, in order) onto every original.
  List<String?> _align(List<String> originals, String? translated) {
    if (translated == null || translated.trim().isEmpty) {
      return List<String?>.filled(originals.length, null);
    }
    final trans = translated.split("\n");
    var j = 0;
    return originals
        .map((o) => o.trim().isNotEmpty ? (j < trans.length ? trans[j++] : null) : null)
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final lyrics = widget.player.lyrics;
    final trackId = widget.player.current?.id;
    if (trackId != _lastTrackId) {
      _lastTrackId = trackId;
      _active = -1;
    }
    final hasLyrics = lyrics != null && (lyrics.synced != null || lyrics.plain != null);
    final hasTrans = lyrics?.translated != null && lyrics!.translated!.trim().isNotEmpty;

    return Column(
      children: [
        if (hasLyrics && hasTrans)
          Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(0, 6, 10, 0),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (lyrics.lang != null)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Text('from ${_langNames[lyrics.lang] ?? lyrics.lang}',
                          style: const TextStyle(color: kMuted, fontSize: 11)),
                    ),
                  TextButton.icon(
                    onPressed: () => setState(() => _showTrans = !_showTrans),
                    icon: Icon(LucideIcons.translate,
                        size: 16, color: _showTrans ? kAccent : kMuted),
                    label: Text(_showTrans ? 'Hide translation' : 'Translate',
                        style: TextStyle(color: _showTrans ? kAccent : kMuted, fontSize: 13)),
                  ),
                ],
              ),
            ),
          ),
        Expanded(child: _body(lyrics, hasTrans && _showTrans)),
      ],
    );
  }

  Widget _body(Lyrics? lyrics, bool showTrans) {
    if (lyrics == null) {
      return const Center(child: Text("Loading lyrics…", style: TextStyle(color: kMuted)));
    }
    if (lyrics.synced != null && lyrics.synced!.isNotEmpty) {
      final lines = _parse(lyrics.synced!);
      final trans = _align(lines.map((l) => l.text).toList(), lyrics.translated);
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
            _scroll.animateTo((active * 56.0 - 160).clamp(0, _scroll.position.maxScrollExtent),
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
            child: Column(
              children: [
                Text(
                  lines[i].text.isEmpty ? "♪" : lines[i].text,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: i == active ? FontWeight.bold : FontWeight.w500,
                    color: i == active ? kAccent : kMuted.withValues(alpha: 0.6),
                  ),
                ),
                if (showTrans && trans[i] != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      trans[i]!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 14,
                        fontStyle: FontStyle.italic,
                        color: i == active
                            ? kAccent.withValues(alpha: 0.75)
                            : kMuted.withValues(alpha: 0.45),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      );
    }
    if (lyrics.plain != null && lyrics.plain!.isNotEmpty) {
      final plainLines = lyrics.plain!.split("\n");
      final trans = _align(plainLines, lyrics.translated);
      return ListView.builder(
        padding: const EdgeInsets.all(24),
        itemCount: plainLines.length,
        itemBuilder: (_, i) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(
            children: [
              Text(plainLines[i].isEmpty ? " " : plainLines[i],
                  textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
              if (showTrans && trans[i] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(trans[i]!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          fontSize: 13,
                          fontStyle: FontStyle.italic,
                          color: kMuted.withValues(alpha: 0.6))),
                ),
            ],
          ),
        ),
      );
    }
    return const Center(child: Text("No lyrics found", style: TextStyle(color: kMuted)));
  }
}
