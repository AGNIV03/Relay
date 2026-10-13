import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/cover.dart';

/// Relay Rewind — a Spotify-Wrapped-style year-in-review. Fetches the year's
/// stats, then plays them back as a full-screen "stories" sequence: a segmented
/// progress bar up top, tap the right half to advance / left to go back, hold to
/// pause, with count-up numbers, staggered reveals and vibrant gradients.
class RewindScreen extends StatefulWidget {
  final int year;
  const RewindScreen({super.key, required this.year});

  @override
  State<RewindScreen> createState() => _RewindScreenState();
}

class _RewindScreenState extends State<RewindScreen> {
  Future<RewindStats>? _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<Api>().rewind(widget.year);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: FutureBuilder<RewindStats>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          final stats = snap.data;
          if (snap.hasError || stats == null || !stats.hasData) {
            return _NotEnough(year: widget.year);
          }
          return _RewindStory(stats: stats);
        },
      ),
    );
  }
}

class _NotEnough extends StatelessWidget {
  final int year;
  const _NotEnough({required this.year});
  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Stack(
        children: [
          Positioned(
            top: 8,
            right: 8,
            child: IconButton(
              icon: const Icon(LucideIcons.x, color: Colors.white),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ),
          Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(LucideIcons.sparkles, size: 56, color: kAccent),
                  const SizedBox(height: 16),
                  Text('Your $year Rewind isn\'t ready yet',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                          fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white)),
                  const SizedBox(height: 10),
                  const Text(
                    'Keep listening and come back later. We need a bit more '
                    'listening history to build your year in music.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: kMuted, fontSize: 14),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

const _months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/// A single story card: a gradient pair plus a builder that receives the card's
/// animation progress (0..1) so it can stagger its reveals.
class _Card {
  final List<Color> gradient;
  final Widget Function(double t) build;
  _Card(this.gradient, this.build);
}

class _RewindStory extends StatefulWidget {
  final RewindStats stats;
  const _RewindStory({required this.stats});
  @override
  State<_RewindStory> createState() => _RewindStoryState();
}

class _RewindStoryState extends State<_RewindStory> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  int _page = 0;
  late final List<_Card> _cards = _buildCards();

  static const _cardDuration = Duration(milliseconds: 5200);

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: _cardDuration)
      ..addStatusListener((s) {
        if (s == AnimationStatus.completed) _next();
      });
    _c.forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _next() {
    if (_page >= _cards.length - 1) {
      // Hold on the final recap card instead of auto-closing.
      _c.value = 1.0;
      return;
    }
    setState(() => _page++);
    _c
      ..reset()
      ..forward();
  }

  void _prev() {
    if (_page == 0) {
      _c
        ..reset()
        ..forward();
      return;
    }
    setState(() => _page--);
    _c
      ..reset()
      ..forward();
  }

  void _tap(TapUpDetails d) {
    final w = MediaQuery.of(context).size.width;
    if (d.localPosition.dx < w * 0.33) {
      _prev();
    } else {
      _next();
    }
  }

  // ---- animation helpers ----
  static double _p(double t, double a, double b) => ((t - a) / (b - a)).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    final card = _cards[_page];
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapUp: _tap,
      onLongPressStart: (_) => _c.stop(),
      onLongPressEnd: (_) => _c.forward(),
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final t = _c.value;
          return Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: card.gradient,
              ),
            ),
            child: SafeArea(
              child: Column(
                children: [
                  _progressBar(),
                  _topBar(),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(28, 8, 28, 28),
                      child: card.build(t),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _progressBar() => Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 2),
        child: Row(
          children: [
            for (var i = 0; i < _cards.length; i++)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(2),
                    child: LinearProgressIndicator(
                      minHeight: 3,
                      value: i < _page
                          ? 1.0
                          : i == _page
                              ? _c.value
                              : 0.0,
                      backgroundColor: Colors.white24,
                      valueColor: const AlwaysStoppedAnimation(Colors.white),
                    ),
                  ),
                ),
              ),
          ],
        ),
      );

  Widget _topBar() => Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Padding(
            padding: EdgeInsets.only(left: 18),
            child: Row(children: [
              Icon(LucideIcons.sparkles, size: 16, color: Colors.white),
              SizedBox(width: 6),
              Text('Relay Rewind',
                  style: TextStyle(
                      color: Colors.white, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
            ]),
          ),
          IconButton(
            icon: const Icon(LucideIcons.x, color: Colors.white),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      );

  // ---- card content ----
  List<_Card> _buildCards() {
    final s = widget.stats;
    final cards = <_Card>[];

    // 1. Intro
    cards.add(_Card([const Color(0xFF0f2027), const Color(0xFF2c5364)], (t) {
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _reveal(t, 0.0, _big('Your', 34, Colors.white70)),
          _reveal(t, 0.12, _big('${s.year}', 92, Colors.white)),
          _reveal(t, 0.24, _big('Rewind', 48, kAccent2)),
          const SizedBox(height: 16),
          _reveal(t, 0.4,
              const Text('A look back at your year in music', style: TextStyle(color: Colors.white70, fontSize: 16))),
        ],
      );
    }));

    // 2. Minutes listened
    cards.add(_Card([const Color(0xFF1d2671), const Color(0xFFc33764)], (t) {
      final shown = (s.totalMinutes * Curves.easeOutCubic.transform(_p(t, 0.05, 0.65))).round();
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _reveal(t, 0.0, const Text('You listened for',
              style: TextStyle(color: Colors.white70, fontSize: 20))),
          const SizedBox(height: 8),
          Text('$shown',
              style: const TextStyle(
                  color: Colors.white, fontSize: 80, fontWeight: FontWeight.w800, height: 1.0)),
          _big('minutes', 30, kAccent2),
          const SizedBox(height: 18),
          _reveal(t, 0.7,
              Text("That's ${s.totalPlays} plays across ${s.distinctTracks} songs",
                  style: const TextStyle(color: Colors.white70, fontSize: 15))),
        ],
      );
    }));

    // 3. Top song
    if (s.topTracks.isNotEmpty) {
      final top = s.topTracks.first;
      cards.add(_Card([const Color(0xFF42275a), const Color(0xFF734b6d)], (t) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reveal(t, 0.0, _label('YOUR #1 SONG')),
            const SizedBox(height: 18),
            _reveal(
              t,
              0.15,
              ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: Cover(
                    url: context.read<Api>().trackCoverUrl(top.id),
                    trackId: top.id,
                    size: 200,
                    radius: 16),
              ),
            ),
            const SizedBox(height: 18),
            _reveal(t, 0.3, _big(top.title, 30, Colors.white)),
            _reveal(t, 0.38,
                Text(top.artist, style: const TextStyle(color: Colors.white70, fontSize: 18))),
            const SizedBox(height: 10),
            _reveal(t, 0.5,
                _pill('Played ${top.playCount} times')),
          ],
        );
      }));
    }

    // 4. Top 5 songs
    if (s.topTracks.length > 1) {
      cards.add(_Card([const Color(0xFF0f0c29), const Color(0xFF302b63)], (t) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reveal(t, 0.0, _label('YOUR TOP SONGS')),
            const SizedBox(height: 18),
            for (var i = 0; i < s.topTracks.length; i++)
              _reveal(t, 0.12 + i * 0.12,
                  _rankRow(i + 1, s.topTracks[i].title, s.topTracks[i].artist)),
          ],
        );
      }));
    }

    // 5. Top artist
    if (s.topArtists.isNotEmpty) {
      final a = s.topArtists.first;
      cards.add(_Card([const Color(0xFFee0979), const Color(0xFFff6a00)], (t) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reveal(t, 0.0, _label('YOUR #1 ARTIST')),
            const SizedBox(height: 10),
            _reveal(t, 0.15, _big(a.name, 56, Colors.white)),
            const SizedBox(height: 12),
            _reveal(t, 0.35, _pill('${a.count} plays this year')),
          ],
        );
      }));
    }

    // 6. Top artists list
    if (s.topArtists.length > 1) {
      cards.add(_Card([const Color(0xFF8e2de2), const Color(0xFF4a00e0)], (t) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reveal(t, 0.0, _label('YOUR TOP ARTISTS')),
            const SizedBox(height: 18),
            for (var i = 0; i < s.topArtists.length; i++)
              _reveal(t, 0.12 + i * 0.12,
                  _rankRow(i + 1, s.topArtists[i].name, '${s.topArtists[i].count} plays')),
          ],
        );
      }));
    }

    // 7. Top genres
    if (s.topGenres.isNotEmpty) {
      cards.add(_Card([const Color(0xFF11998e), const Color(0xFF38ef7d)], (t) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reveal(t, 0.0, _label('YOUR TOP GENRES', dark: true)),
            const SizedBox(height: 16),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (var i = 0; i < s.topGenres.length; i++)
                  _reveal(t, 0.12 + i * 0.12, _genreChip(s.topGenres[i].name, i)),
              ],
            ),
          ],
        );
      }));
    }

    // 8. Breadth + a light "personality"
    cards.add(_Card([const Color(0xFF373B44), const Color(0xFF4286f4)], (t) {
      final artists = (s.distinctArtists * Curves.easeOut.transform(_p(t, 0.05, 0.5))).round();
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _reveal(t, 0.0, const Text('You explored',
              style: TextStyle(color: Colors.white70, fontSize: 20))),
          Text('$artists', style: const TextStyle(color: Colors.white, fontSize: 72, fontWeight: FontWeight.w800)),
          _big('different artists', 26, kAccent2),
          const SizedBox(height: 20),
          _reveal(t, 0.55, _pill(_personality(s))),
        ],
      );
    }));

    // 9. Peak month
    final peakMin = s.monthMinutes.isNotEmpty ? s.monthMinutes[s.peakMonth] : 0;
    if (peakMin > 0) {
      cards.add(_Card([const Color(0xFFf7971e), const Color(0xFFffd200)], (t) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reveal(t, 0.0, _label('YOUR BIGGEST MONTH', dark: true)),
            const SizedBox(height: 8),
            _reveal(t, 0.15, _big(_months[s.peakMonth], 56, const Color(0xFF3a2d00))),
            const SizedBox(height: 10),
            _reveal(t, 0.35,
                Text('$peakMin minutes that month',
                    style: const TextStyle(color: Color(0xFF3a2d00), fontSize: 18, fontWeight: FontWeight.w600))),
          ],
        );
      }));
    }

    // 10. Recap / shareable summary
    cards.add(_Card([const Color(0xFF232526), const Color(0xFF414345)], (t) {
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _reveal(t, 0.0, _big('Your ${s.year}', 30, Colors.white70)),
          _reveal(t, 0.08, _big('in music', 40, kAccent2)),
          const SizedBox(height: 20),
          _reveal(t, 0.2, _recapRow(LucideIcons.clock, '${s.totalMinutes} minutes')),
          _reveal(t, 0.3, _recapRow(LucideIcons.music2, '${s.distinctTracks} songs · ${s.distinctArtists} artists')),
          if (s.topTracks.isNotEmpty)
            _reveal(t, 0.4, _recapRow(LucideIcons.star, 'Top song: ${s.topTracks.first.title}')),
          if (s.topArtists.isNotEmpty)
            _reveal(t, 0.5, _recapRow(LucideIcons.mic2, 'Top artist: ${s.topArtists.first.name}')),
          if (s.topGenres.isNotEmpty)
            _reveal(t, 0.6, _recapRow(LucideIcons.disc3, 'Top genre: ${s.topGenres.first.name}')),
          const SizedBox(height: 24),
          _reveal(
            t,
            0.72,
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: kAccent, foregroundColor: kAccentInk),
              icon: const Icon(LucideIcons.check, size: 18),
              label: const Text('Done'),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ),
        ],
      );
    }));

    return cards;
  }

  // ---- small building blocks ----
  Widget _reveal(double t, double start, Widget child) {
    final p = _p(t, start, start + 0.18);
    return Opacity(
      opacity: p,
      child: Transform.translate(offset: Offset(0, 18 * (1 - p)), child: child),
    );
  }

  Widget _big(String s, double size, Color color) => Text(s,
      style: TextStyle(color: color, fontSize: size, fontWeight: FontWeight.w800, height: 1.05));

  Widget _label(String s, {bool dark = false}) => Text(s,
      style: TextStyle(
          color: dark ? Colors.black54 : Colors.white70,
          fontSize: 14,
          fontWeight: FontWeight.w700,
          letterSpacing: 2));

  Widget _pill(String s) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(999)),
        child: Text(s,
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
      );

  Widget _rankRow(int rank, String title, String sub) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          SizedBox(
            width: 34,
            child: Text('$rank',
                style: const TextStyle(
                    color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800)),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600)),
              Text(sub,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white70, fontSize: 13)),
            ]),
          ),
        ]),
      );

  Widget _genreChip(String name, int i) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(name,
            style: TextStyle(
                color: Colors.white,
                fontSize: 20 - (i * 1.5).clamp(0, 8).toDouble(),
                fontWeight: FontWeight.w700)),
      );

  Widget _recapRow(IconData icon, String s) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(children: [
          Icon(icon, size: 18, color: kAccent2),
          const SizedBox(width: 12),
          Expanded(
            child: Text(s,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 16)),
          ),
        ]),
      );

  /// A light, derived "listening personality" from breadth vs. repetition.
  String _personality(RewindStats s) {
    if (s.totalPlays == 0 || s.distinctTracks == 0) return 'The Listener';
    final repeatRatio = s.totalPlays / s.distinctTracks; // higher = more replays
    final breadth = s.distinctArtists;
    if (repeatRatio >= 4) return 'The Replayer';
    if (breadth >= 60) return 'The Explorer';
    if (breadth >= 25) return 'The Adventurer';
    if (repeatRatio >= 2) return 'The Loyalist';
    return 'The Specialist';
  }
}
