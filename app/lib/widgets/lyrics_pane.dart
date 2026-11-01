import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';

const _langNames = {
  'ja': 'Japanese', 'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian',
  'ko': 'Korean', 'zh': 'Chinese', 'pt': 'Portuguese', 'ru': 'Russian', 'hi': 'Hindi',
  'ar': 'Arabic', 'nl': 'Dutch', 'sv': 'Swedish', 'pl': 'Polish', 'tr': 'Turkish',
};

/// Scrolling, time-synced lyrics for the current track (tap a line to seek). The
/// current line auto-centres in the view; the user can scroll freely, which pauses
/// auto-follow and shows a "sync" button to re-centre + resume following.
class LyricsPane extends StatefulWidget {
  final PlayerModel player;
  const LyricsPane({super.key, required this.player});
  @override
  State<LyricsPane> createState() => _LyricsPaneState();
}

class _LyricsPaneState extends State<LyricsPane> {
  final _scroll = ScrollController();
  final _activeKey = GlobalKey();
  int _active = -1;
  String? _lastTrackId;
  bool _showTrans = true; // default on whenever a translation exists
  bool _following = true; // auto-centre the current line until the user scrolls

  // Parsed LRC, cached per lyrics text (it used to be re-parsed on every build).
  String? _parsedSrc;
  List<({double t, String text})> _lines = const [];

  @override
  void initState() {
    super.initState();
    widget.player.positionTick.addListener(_onTick);
  }

  @override
  void didUpdateWidget(covariant LyricsPane old) {
    super.didUpdateWidget(old);
    if (old.player != widget.player) {
      old.player.positionTick.removeListener(_onTick);
      widget.player.positionTick.addListener(_onTick);
    }
  }

  @override
  void dispose() {
    widget.player.positionTick.removeListener(_onTick);
    _scroll.dispose();
    super.dispose();
  }

  List<({double t, String text})> _linesFor(String lrc) {
    if (lrc != _parsedSrc) {
      _parsedSrc = lrc;
      _lines = _parse(lrc);
    }
    return _lines;
  }

  int _activeAt(List<({double t, String text})> lines) {
    final pos = widget.player.position.inMilliseconds / 1000.0;
    var active = -1;
    for (var i = 0; i < lines.length; i++) {
      if (pos >= lines[i].t - 0.2) {
        active = i;
      } else {
        break;
      }
    }
    return active;
  }

  /// Position tick: rebuild only when the highlighted line actually changes.
  void _onTick() {
    final synced = widget.player.lyrics?.synced;
    if (synced == null || synced.isEmpty || !mounted) return;
    if (_activeAt(_linesFor(synced)) != _active) setState(() {});
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

  /// Centre the active line in the viewport. If it isn't currently built (the user
  /// scrolled it off-screen), jump near it first so it builds, then centre precisely.
  void _centerActive() {
    if (!_scroll.hasClients || _active < 0) return;
    final ctx = _activeKey.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(ctx,
          alignment: 0.5, duration: const Duration(milliseconds: 350), curve: Curves.easeOut);
      return;
    }
    // Off-screen: jump to a rough estimate, then refine next frame.
    final est = (_active * 56.0 - _scroll.position.viewportDimension / 2)
        .clamp(0.0, _scroll.position.maxScrollExtent);
    _scroll.jumpTo(est);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final c = _activeKey.currentContext;
      if (c != null) {
        Scrollable.ensureVisible(c,
            alignment: 0.5, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  void _resync() {
    setState(() => _following = true);
    WidgetsBinding.instance.addPostFrameCallback((_) => _centerActive());
  }

  @override
  Widget build(BuildContext context) {
    final lyrics = widget.player.lyrics;
    final trackId = widget.player.current?.id;
    if (trackId != _lastTrackId) {
      _lastTrackId = trackId;
      _active = -1;
      _following = true; // re-follow on a new track
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
      final lines = _linesFor(lyrics.synced!);
      final trans = _align(lines.map((l) => l.text).toList(), lyrics.translated);
      final active = _activeAt(lines);
      if (active != _active) {
        _active = active;
        if (_following) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _centerActive());
        }
      }
      return Stack(
        children: [
          NotificationListener<ScrollNotification>(
            // A user-initiated scroll pauses auto-follow.
            onNotification: (n) {
              if (n is UserScrollNotification &&
                  n.direction != ScrollDirection.idle &&
                  _following) {
                setState(() => _following = false);
              }
              return false;
            },
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 30),
              itemCount: lines.length,
              itemBuilder: (_, i) => GestureDetector(
                key: i == active ? _activeKey : null,
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
            ),
          ),
          // Re-sync button: only while auto-follow is paused and a line is active.
          if (!_following && active >= 0)
            Positioned(
              right: 16,
              bottom: 16,
              child: FloatingActionButton.small(
                backgroundColor: kAccent,
                foregroundColor: kAccentInk,
                onPressed: _resync,
                tooltip: 'Sync to current line',
                child: const Icon(Icons.vertical_align_center, size: 20),
              ),
            ),
        ],
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
