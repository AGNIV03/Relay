import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';

const _langNames = {
  'ja': 'Japanese', 'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian',
  'ko': 'Korean', 'zh': 'Chinese', 'pt': 'Portuguese', 'ru': 'Russian', 'hi': 'Hindi',
  'ar': 'Arabic', 'nl': 'Dutch', 'sv': 'Swedish', 'pl': 'Polish', 'tr': 'Turkish',
};

/// Scrolling, time-synced lyrics for the current track (tap a line to seek),
/// with a Translate toggle that shows an English machine translation.
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

  bool _showTrans = false;
  bool _loadingTrans = false;
  String? _trans;
  String? _lang;

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

  Future<void> _loadTranslation(String trackId) async {
    if (_loadingTrans) return;
    setState(() => _loadingTrans = true);
    ({String? lang, String? translated})? r;
    try {
      r = await context.read<Api>().lyricsTranslation(trackId);
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _trans = r?.translated;
      _lang = r?.lang;
      _loadingTrans = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final lyrics = widget.player.lyrics;
    final trackId = widget.player.current?.id;

    // Reset the translation view when the track changes.
    if (trackId != _lastTrackId) {
      _lastTrackId = trackId;
      if (_showTrans || _trans != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          setState(() {
            _showTrans = false;
            _trans = null;
            _lang = null;
          });
        });
      }
    }

    final hasLyrics = lyrics != null && (lyrics.synced != null || lyrics.plain != null);

    return Column(
      children: [
        if (hasLyrics)
          Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(0, 6, 10, 0),
              child: TextButton.icon(
                onPressed: trackId == null
                    ? null
                    : () {
                        setState(() => _showTrans = !_showTrans);
                        if (_showTrans) _loadTranslation(trackId);
                      },
                icon: Icon(LucideIcons.translate,
                    size: 16, color: _showTrans ? kAccent : kMuted),
                label: Text(_showTrans ? 'Original' : 'Translate',
                    style: TextStyle(color: _showTrans ? kAccent : kMuted, fontSize: 13)),
              ),
            ),
          ),
        Expanded(child: _showTrans ? _translated() : _original(lyrics)),
      ],
    );
  }

  Widget _translated() {
    if (_loadingTrans) {
      return const Center(child: Text("Translating…", style: TextStyle(color: kMuted)));
    }
    if (_trans != null && _trans!.trim().isNotEmpty) {
      return SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(children: [
          if (_lang != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Text("Translated from ${_langNames[_lang] ?? _lang}",
                  style: const TextStyle(color: kMuted, fontSize: 12)),
            ),
          Text(_trans!,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 16, height: 1.6)),
        ]),
      );
    }
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Text("No translation available\n(the lyrics may already be in English)",
            textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
      ),
    );
  }

  Widget _original(Lyrics? lyrics) {
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
