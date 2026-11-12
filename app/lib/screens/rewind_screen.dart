import 'dart:io' show File, Platform, Process;
import 'dart:math' as math;
import 'dart:ui' as ui show ImageByteFormat;
import 'dart:ui' show ImageFilter;
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderRepaintBoundary;
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';

/// Relay Rewind: a Spotify-Wrapped-style year in review.
///
/// Fetches the year's stats, then plays them back as full-screen "stories": a
/// segmented progress bar, tap right to advance / left to go back, hold to pause.
/// Every card has its own song (crossfaded in through the main player's preview
/// mode, which never scrobbles and restores your queue on exit) and its cover
/// drifts, blurred, behind the card. Cards enter with varied transitions and each
/// has its own set piece (vinyl, pulsing rings, bubbles, a month chart, confetti).
/// Where Rewind lives through the year:
///  - Dec 20 to Dec 31: this year's Rewind is featured on Home.
///  - Jan 1 to Jan 7: last year's Rewind is still on Home.
///  - Jan 8 to Dec 19: last year's Rewind moves to Profile, where it stays
///    until the next one appears on Home.
class RewindSchedule {
  static int? homeYear([DateTime? now]) {
    final n = now ?? DateTime.now();
    if (n.month == 12 && n.day >= 20) return n.year;
    if (n.month == 1 && n.day <= 7) return n.year - 1;
    return null;
  }

  static int? profileYear([DateTime? now]) {
    final n = now ?? DateTime.now();
    return homeYear(n) == null ? n.year - 1 : null;
  }
}

/// Shows [builder]'s entry point (banner / tile) only when [year] actually has
/// listening data, so nobody is offered an empty Rewind.
class RewindGate extends StatefulWidget {
  final int year;
  final WidgetBuilder builder;
  const RewindGate({super.key, required this.year, required this.builder});
  @override
  State<RewindGate> createState() => _RewindGateState();
}

class _RewindGateState extends State<RewindGate> {
  late final Future<bool> _has = context
      .read<Api>()
      .rewind(widget.year)
      .then((s) => s.hasData)
      .catchError((_) => false);

  @override
  Widget build(BuildContext context) => FutureBuilder<bool>(
        future: _has,
        builder: (context, snap) =>
            snap.data == true ? widget.builder(context) : const SizedBox.shrink(),
      );
}

/// Open Rewind full-screen on the ROOT navigator. Each tab has its own nested
/// navigator (TabNavigator), and pushing there would leave the bottom nav and
/// mini-player drawn over the story.
Future<void> openRewind(BuildContext context, int year) =>
    Navigator.of(context, rootNavigator: true).push(MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => RewindScreen(year: year),
    ));

class RewindScreen extends StatefulWidget {
  final int year;
  const RewindScreen({super.key, required this.year});

  @override
  State<RewindScreen> createState() => _RewindScreenState();
}

class _RewindData {
  final RewindStats stats;
  final Map<String, Track> tracks; // id -> Track, for audio + metadata
  _RewindData(this.stats, this.tracks);
}

class _RewindScreenState extends State<RewindScreen> {
  late final Future<_RewindData> _future = _load();

  Future<_RewindData> _load() async {
    final api = context.read<Api>();
    final stats = await api.rewind(widget.year);
    final ids = <String>{
      for (final t in stats.topTracks) t.id,
      for (final a in stats.topArtists) ?a.trackId,
      for (final g in stats.topGenres) ?g.trackId,
      ?stats.peakMonthTrackId,
    }..removeWhere((id) => id.isEmpty);
    var tracks = <String, Track>{};
    try {
      tracks = {for (final t in await api.tracksByIds(ids.toList())) t.id: t};
    } catch (_) {} // no audio is fine; the story still plays silently
    return _RewindData(stats, tracks);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: FutureBuilder<_RewindData>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const _Loading();
          }
          final data = snap.data;
          if (snap.hasError || data == null || !data.stats.hasData) {
            return _NotEnough(year: widget.year);
          }
          return _RewindStory(data: data);
        },
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();
  @override
  Widget build(BuildContext context) => const Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(LucideIcons.sparkles, color: kAccent, size: 40),
          SizedBox(height: 16),
          Text('Rewinding your year…', style: TextStyle(color: Colors.white70, fontSize: 16)),
          SizedBox(height: 16),
          SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5)),
        ]),
      );
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
                  Text("Your $year Rewind isn't ready yet",
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

enum _Fx { zoom, slideUp, swirl, slideSide }

/// One story card: its colours, the song that plays behind it, how long it
/// stays up, how it enters, and a builder fed (t = card progress 0..1,
/// a = ambient loop phase 0..1).
class _Card {
  final List<Color> gradient;
  final String? trackId;
  // How long the card stays up, and how long its reveal animations take. The
  // reveal runs at its own pace and the card then holds on the finished slide
  // for the remainder, so lengthening [duration] doesn't slow the animations.
  final Duration duration;
  final Duration reveal;
  final _Fx fx;
  final Widget Function(double t, double a) build;
  _Card({
    required this.gradient,
    required this.trackId,
    required this.build,
    this.duration = const Duration(milliseconds: 11000),
    this.reveal = const Duration(milliseconds: 7000),
    this.fx = _Fx.zoom,
  });

  /// Reveal progress (0..1) for an elapsed fraction [c] of [duration].
  double revealT(double c) =>
      (c * duration.inMilliseconds / reveal.inMilliseconds).clamp(0.0, 1.0);
}

class _RewindStory extends StatefulWidget {
  final _RewindData data;
  const _RewindStory({required this.data});
  @override
  State<_RewindStory> createState() => _RewindStoryState();
}

class _RewindStoryState extends State<_RewindStory> with TickerProviderStateMixin {
  late final AnimationController _c; // current card's timer
  late final AnimationController _amb; // endless ambient loop (drift, spin, bars)
  late final PlayerModel _player;
  late final Api _api;
  late final List<_Card> _cards;
  int _page = 0;
  // Share image: while [_sharing] the 1080x1920 card is mounted (hidden behind
  // the story) so it can be rasterised through [_shareKey].
  bool _sharing = false;
  final _shareKey = GlobalKey();
  bool _audio = false; // preview mode acquired (false in a Chorus / listen-along)
  bool _muted = false;
  String? _playingId;

  RewindStats get _s => widget.data.stats;

  @override
  void initState() {
    super.initState();
    _player = context.read<PlayerModel>();
    _api = context.read<Api>();
    _cards = _buildCards();
    _amb = AnimationController(vsync: this, duration: const Duration(seconds: 14))..repeat();
    _c = AnimationController(vsync: this, duration: _cards.first.duration)
      ..addStatusListener((s) {
        if (s == AnimationStatus.completed) _next(auto: true);
      });
    _c.forward();
    _startAudio();
  }

  Future<void> _startAudio() async {
    _audio = await _player.beginPreview();
    if (mounted) setState(() {});
    _syncSong();
  }

  @override
  void dispose() {
    _c.dispose();
    _amb.dispose();
    _player.endPreview(); // restores the user's own queue + position
    super.dispose();
  }

  /// Crossfade to the current card's song if it differs from what's playing.
  void _syncSong() {
    if (!_audio) return;
    final id = _cards[_page].trackId;
    final t = id == null ? null : widget.data.tracks[id];
    if (t == null || t.id == _playingId) return;
    _playingId = t.id;
    _player.previewTrack(t);
  }

  void _go(int page) {
    if (page < 0 || page >= _cards.length) return;
    HapticFeedback.selectionClick();
    setState(() => _page = page);
    _c
      ..duration = _cards[page].duration
      ..reset()
      ..forward();
    _syncSong();
  }

  void _next({bool auto = false}) {
    if (_page >= _cards.length - 1) {
      _c.value = 1.0; // hold on the recap instead of closing
      return;
    }
    _go(_page + 1);
  }

  void _prev() {
    if (_page == 0) {
      _c
        ..reset()
        ..forward();
      return;
    }
    _go(_page - 1);
  }

  void _restart() {
    _go(0);
  }

  void _tap(TapUpDetails d) {
    final w = MediaQuery.of(context).size.width;
    if (d.localPosition.dx < w * 0.33) {
      _prev();
    } else {
      _next();
    }
  }

  void _hold(bool on) {
    if (on) {
      _c.stop();
    } else if (_c.value < 1) {
      _c.forward();
    }
    _player.setPreviewPaused(on);
  }

  void _toggleMute() {
    setState(() => _muted = !_muted);
    _player.setPreviewMuted(_muted);
  }

  String _cover(String id) => _api.trackCoverUrl(id);

  /// Render the share card off-screen to a 1080x1920 PNG, then share it (share
  /// sheet on Android; on desktop it's saved to Downloads and shown in the folder).
  Future<void> _share() async {
    if (_sharing) return;
    final messenger = ScaffoldMessenger.of(context);
    _hold(true); // pause the story + preview audio while we work
    setState(() => _sharing = true);
    try {
      // Warm the cover images so the card paints with them on its first frame.
      await Future.wait([
        precacheImage(const AssetImage('assets/logo.png'), context),
        for (final t in _s.topTracks.take(5))
          precacheImage(
            CachedNetworkImageProvider(_cover(t.id), cacheKey: coverCacheKey(_cover(t.id))),
            context,
            onError: (_, _) {},
          ),
      ]).timeout(const Duration(seconds: 6), onTimeout: () => const []);
      await WidgetsBinding.instance.endOfFrame;
      await WidgetsBinding.instance.endOfFrame;
      final boundary = _shareKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      if (boundary == null) throw 'Share card not ready';
      final image = await boundary.toImage(pixelRatio: _ShareCard.scale);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      if (png == null) throw 'Could not encode the image';
      final bytes = png.buffer.asUint8List();
      final name = 'relay-rewind-${_s.year}.png';
      final desktop = !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);
      if (desktop) {
        final dir = await getDownloadsDirectory() ?? await getApplicationDocumentsDirectory();
        final file = File('${dir.path}${Platform.pathSeparator}$name');
        await file.writeAsBytes(bytes);
        messenger.showSnackBar(SnackBar(content: Text('Saved to ${file.path}')));
        try {
          if (Platform.isWindows) {
            await Process.start('explorer.exe', ['/select,', file.path]);
          } else if (Platform.isMacOS) {
            await Process.start('open', ['-R', file.path]);
          } else {
            await Process.start('xdg-open', [dir.path]);
          }
        } catch (_) {}
      } else {
        final dir = await getTemporaryDirectory();
        final file = File('${dir.path}/$name');
        await file.writeAsBytes(bytes);
        await SharePlus.instance.share(ShareParams(
          files: [XFile(file.path, mimeType: 'image/png')],
          text: 'My ${_s.year} in music on Relay',
        ));
      }
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't create the share image: $e")));
    } finally {
      if (mounted) setState(() => _sharing = false);
      _hold(false);
    }
  }

  static double _p(double t, double a, double b) => ((t - a) / (b - a)).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    final card = _cards[_page];
    final myPage = _page;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapUp: _tap,
      onLongPressStart: (_) => _hold(true),
      onLongPressEnd: (_) => _hold(false),
      child: Stack(
        fit: StackFit.expand,
        children: [
          // The share card, mounted only while sharing and painted underneath
          // everything (fully covered by the backdrop) so it can be captured.
          if (_sharing)
            Positioned(
              left: 0,
              top: 0,
              child: RepaintBoundary(
                key: _shareKey,
                child: _ShareCard(
                  stats: _s,
                  coverUrl: _cover,
                  personality: _personalityInfo(_s),
                ),
              ),
            ),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 900),
            child: _Backdrop(
              key: ValueKey('bg$_page'),
              gradient: card.gradient,
              coverUrl: card.trackId == null ? null : _cover(card.trackId!),
              ambient: _amb,
            ),
          ),
          IgnorePointer(
            child: AnimatedBuilder(
              animation: _amb,
              builder: (context, _) =>
                  CustomPaint(painter: _BlobPainter(_amb.value, card.gradient)),
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                AnimatedBuilder(animation: _c, builder: (context, _) => _progressBar()),
                _topBar(),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 650),
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeInCubic,
                    transitionBuilder: (child, anim) => _transition(card.fx, child, anim),
                    child: KeyedSubtree(
                      key: ValueKey(myPage),
                      child: AnimatedBuilder(
                        animation: Listenable.merge([_c, _amb]),
                        builder: (context, _) {
                          // An outgoing card keeps its fully-revealed state while it
                          // animates out (the timer has already reset for the new one).
                          final t = myPage == _page ? _cards[myPage].revealT(_c.value) : 1.0;
                          // SizedBox.expand: every card fills the screen, so left-aligned
                          // content lines up at the padding instead of shrink-wrapping
                          // and being centred (and the intro's covers aren't clipped).
                          return Padding(
                            padding: const EdgeInsets.fromLTRB(26, 4, 26, 24),
                            child: SizedBox.expand(child: _cards[myPage].build(t, _amb.value)),
                          );
                        },
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _transition(_Fx fx, Widget child, Animation<double> anim) {
    final fade = FadeTransition(opacity: anim, child: child);
    switch (fx) {
      case _Fx.zoom:
        return ScaleTransition(scale: Tween(begin: 0.86, end: 1.0).animate(anim), child: fade);
      case _Fx.slideUp:
        return SlideTransition(
            position: Tween(begin: const Offset(0, 0.14), end: Offset.zero).animate(anim),
            child: fade);
      case _Fx.swirl:
        return RotationTransition(
          turns: Tween(begin: -0.035, end: 0.0).animate(anim),
          child: ScaleTransition(scale: Tween(begin: 0.9, end: 1.0).animate(anim), child: fade),
        );
      case _Fx.slideSide:
        return SlideTransition(
            position: Tween(begin: const Offset(0.28, 0), end: Offset.zero).animate(anim),
            child: fade);
    }
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
        children: [
          const SizedBox(width: 18),
          const Icon(LucideIcons.sparkles, size: 16, color: Colors.white),
          const SizedBox(width: 6),
          const Text('Relay Rewind',
              style: TextStyle(
                  color: Colors.white, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
          const SizedBox(width: 10),
          if (_audio && !_muted)
            AnimatedBuilder(animation: _amb, builder: (context, _) => _Equalizer(phase: _amb.value)),
          const Spacer(),
          if (_audio)
            IconButton(
              tooltip: _muted ? 'Unmute' : 'Mute',
              icon: Icon(_muted ? Icons.volume_off_rounded : Icons.volume_up_rounded,
                  color: Colors.white),
              onPressed: _toggleMute,
            ),
          IconButton(
            icon: const Icon(LucideIcons.x, color: Colors.white),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      );

  // ---------------------------------------------------------------- cards ----
  List<_Card> _buildCards() {
    final s = _s;
    final tt = s.topTracks;
    String? trackAt(int i) => tt.length > i ? tt[i].id : (tt.isNotEmpty ? tt.first.id : null);
    final cards = <_Card>[];

    // 1. Intro: covers float up behind the title.
    cards.add(_Card(
      gradient: const [Color(0xFF0f2027), Color(0xFF2c5364)],
      trackId: trackAt(tt.length > 2 ? 2 : tt.length - 1),
      duration: const Duration(milliseconds: 9500),
      reveal: const Duration(milliseconds: 6500),
      fx: _Fx.zoom,
      build: (t, a) => LayoutBuilder(
        builder: (context, box) => Stack(
          clipBehavior: Clip.none, // covers may drift past the padding
          children: [
            for (var i = 0; i < math.min(tt.length, 5); i++)
              _floatingCover(tt[i].id, i, t, a, box.biggest),
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _rise(t, 0.0, _big('Your', 34, Colors.white70)),
                _pop(t, 0.10, _big('${s.year}', 96, Colors.white)),
                _rise(t, 0.24, _gradientText('Rewind', 54)),
                const SizedBox(height: 16),
                _rise(t, 0.4,
                    const Text("Let's play back your year in music",
                        style: TextStyle(color: Colors.white70, fontSize: 16))),
              ],
            ),
          ],
        ),
      ),
    ));

    // 2. Minutes listened: the hero number.
    cards.add(_Card(
      gradient: const [Color(0xFF1d2671), Color(0xFFc33764)],
      trackId: trackAt(1),
      fx: _Fx.slideUp,
      build: (t, a) {
        final shown = (s.totalMinutes * Curves.easeOutCubic.transform(_p(t, 0.08, 0.6))).round();
        final hours = (s.totalMinutes / 60).round();
        final landed = _p(t, 0.58, 0.68);
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _rise(t, 0.0,
                const Text('This year you listened for',
                    style: TextStyle(color: Colors.white70, fontSize: 20))),
            const SizedBox(height: 6),
            Transform.scale(
              alignment: Alignment.centerLeft,
              scale: 1 + 0.12 * math.sin(landed * math.pi), // little bounce as it lands
              child: Text(_fmt(shown),
                  style: const TextStyle(
                      color: Colors.white, fontSize: 84, fontWeight: FontWeight.w900, height: 1.0)),
            ),
            _big('minutes', 32, kAccent2),
            const SizedBox(height: 6),
            _underline(_p(t, 0.6, 0.8)),
            const SizedBox(height: 18),
            if (hours >= 2)
              _rise(t, 0.68,
                  _pill("That's about ${_fmt(hours)} hours of music")),
            const SizedBox(height: 10),
            _rise(t, 0.78,
                Text('${_fmt(s.totalPlays)} plays across ${_fmt(s.distinctTracks)} songs',
                    style: const TextStyle(color: Colors.white70, fontSize: 15))),
          ],
        );
      },
    ));

    // 3. Top songs countdown (5 → 1), music stays on #2 to save #1 for its reveal.
    if (tt.length > 1) {
      cards.add(_Card(
        gradient: const [Color(0xFF0f0c29), Color(0xFF302b63)],
        trackId: trackAt(1),
        duration: const Duration(milliseconds: 13000),
        reveal: const Duration(milliseconds: 8500),
        fx: _Fx.slideSide,
        build: (t, a) {
          final n = tt.length;
          return Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _rise(t, 0.0, _label('YOUR TOP SONGS')),
              const SizedBox(height: 16),
              for (var i = 0; i < n; i++)
                _slideIn(
                  t,
                  0.1 + (n - 1 - i) * 0.13, // reveal bottom-up: #5 first, #1 last
                  _rankRow(i + 1, tt[i].title, tt[i].artist, tt[i].id,
                      glow: i == 0 ? _p(t, 0.1 + (n - 1) * 0.13 + 0.15, 1.0) : 0),
                ),
            ],
          );
        },
      ));
    }

    // 4. #1 song: a record slides out of its sleeve and spins. Music switches to #1.
    if (tt.isNotEmpty) {
      final top = tt.first;
      final track = widget.data.tracks[top.id];
      cards.add(_Card(
        gradient: const [Color(0xFF42275a), Color(0xFF734b6d)],
        trackId: top.id,
        duration: const Duration(milliseconds: 12500),
        reveal: const Duration(milliseconds: 8000),
        fx: _Fx.swirl,
        build: (t, a) {
          final minutesWith =
              track != null ? (top.playCount * track.duration / 60).round() : 0;
          return Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _rise(t, 0.0, _label('YOUR #1 SONG OF ${s.year}')),
              const SizedBox(height: 18),
              _pop(t, 0.05, _vinyl(top.id, t, a)),
              const SizedBox(height: 20),
              _rise(t, 0.35, _big(top.title, 32, Colors.white, maxLines: 2)),
              _rise(t, 0.42,
                  Text(top.artist, style: const TextStyle(color: Colors.white70, fontSize: 18))),
              const SizedBox(height: 12),
              _rise(t, 0.55, _pill('Played ${_fmt(top.playCount)} times')),
              if (minutesWith > 0) ...[
                const SizedBox(height: 8),
                _rise(t, 0.65, _pill("That's ${_fmt(minutesWith)} minutes on repeat")),
              ],
            ],
          );
        },
      ));
    }

    // 5. #1 artist: their cover with pulsing rings.
    if (s.topArtists.isNotEmpty) {
      final ar = s.topArtists.first;
      cards.add(_Card(
        gradient: const [Color(0xFFee0979), Color(0xFFff6a00)],
        trackId: ar.trackId,
        fx: _Fx.zoom,
        build: (t, a) => Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _rise(t, 0.0, _label('YOUR #1 ARTIST')),
            const SizedBox(height: 18),
            _pop(
              t,
              0.08,
              SizedBox(
                width: 260,
                height: 260,
                child: Stack(alignment: Alignment.center, children: [
                  CustomPaint(size: const Size(260, 260), painter: _RingsPainter(a)),
                  ClipOval(
                    child: SizedBox(
                      width: 170,
                      height: 170,
                      child: ar.trackId == null
                          ? Container(
                              color: Colors.white24,
                              child: const Icon(LucideIcons.mic2, size: 70, color: Colors.white))
                          : Cover(url: _cover(ar.trackId!), trackId: ar.trackId, size: 170, radius: 0),
                    ),
                  ),
                ]),
              ),
            ),
            const SizedBox(height: 14),
            _pop(t, 0.3, _big(ar.name, 44, Colors.white, center: true, maxLines: 2)),
            const SizedBox(height: 12),
            _rise(t, 0.45, _pill('${_fmt(ar.count)} plays this year')),
          ],
        ),
      ));
    }

    // 6. Top artists list.
    if (s.topArtists.length > 1) {
      cards.add(_Card(
        gradient: const [Color(0xFF8e2de2), Color(0xFF4a00e0)],
        trackId: s.topArtists[1].trackId ?? s.topArtists.first.trackId,
        fx: _Fx.slideUp,
        build: (t, a) => Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _rise(t, 0.0, _label('YOUR TOP ARTISTS')),
            const SizedBox(height: 16),
            for (var i = 0; i < s.topArtists.length; i++)
              _slideIn(
                  t,
                  0.1 + i * 0.12,
                  _rankRow(i + 1, s.topArtists[i].name, '${_fmt(s.topArtists[i].count)} plays',
                      s.topArtists[i].trackId,
                      round: true)),
          ],
        ),
      ));
    }

    // 7. Genres: bubbles that pop in and bob.
    if (s.topGenres.isNotEmpty) {
      cards.add(_Card(
        gradient: const [Color(0xFF11998e), Color(0xFF38ef7d)],
        trackId: s.topGenres.first.trackId,
        fx: _Fx.swirl,
        build: (t, a) => Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _rise(t, 0.0, _label('YOUR TOP GENRES', dark: true)),
            const SizedBox(height: 6),
            _rise(t, 0.05,
                _big(s.topGenres.first.name, 46, const Color(0xFF053d33), maxLines: 2)),
            const SizedBox(height: 22),
            Wrap(
              spacing: 12,
              runSpacing: 14,
              children: [
                for (var i = 0; i < s.topGenres.length; i++)
                  _bubble(t, a, i, s.topGenres[i].name),
              ],
            ),
          ],
        ),
      ));
    }

    // 8. Peak month: the bars grow, the peak lights up.
    final peakMin = s.monthMinutes.length == 12 ? s.monthMinutes[s.peakMonth] : 0;
    if (peakMin > 0) {
      cards.add(_Card(
        gradient: const [Color(0xFFf7971e), Color(0xFFffd200)],
        trackId: s.peakMonthTrackId ?? trackAt(0),
        fx: _Fx.slideSide,
        build: (t, a) => Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _rise(t, 0.0, _label('YOUR BIGGEST MONTH', dark: true)),
            const SizedBox(height: 6),
            _pop(t, 0.5, _big(_months[s.peakMonth], 58, const Color(0xFF3a2d00))),
            const SizedBox(height: 4),
            _rise(t, 0.58,
                Text('${_fmt(peakMin)} minutes that month',
                    style: const TextStyle(
                        color: Color(0xFF3a2d00), fontSize: 18, fontWeight: FontWeight.w600))),
            const SizedBox(height: 26),
            _monthChart(t),
          ],
        ),
      ));
    }

    // 9. Breadth + listening personality (badge flips in).
    cards.add(_Card(
      gradient: const [Color(0xFF373B44), Color(0xFF4286f4)],
      trackId: trackAt(2),
      fx: _Fx.zoom,
      build: (t, a) {
        final artists = (s.distinctArtists * Curves.easeOut.transform(_p(t, 0.05, 0.45))).round();
        final flip = Curves.easeOutBack.transform(_p(t, 0.5, 0.75));
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _rise(t, 0.0,
                const Text('You explored', style: TextStyle(color: Colors.white70, fontSize: 20))),
            Text(_fmt(artists),
                style: const TextStyle(
                    color: Colors.white, fontSize: 80, fontWeight: FontWeight.w900, height: 1.0)),
            _big('different artists', 28, kAccent2),
            const SizedBox(height: 30),
            _rise(t, 0.45,
                const Text('Your listening personality',
                    style: TextStyle(color: Colors.white70, fontSize: 15))),
            const SizedBox(height: 10),
            Opacity(
              opacity: _p(t, 0.5, 0.56),
              child: Transform(
                alignment: Alignment.centerLeft,
                transform: Matrix4.identity()
                  ..setEntry(3, 2, 0.0015)
                  ..rotateY((1 - flip) * math.pi / 2),
                child: _personalityBadge(),
              ),
            ),
          ],
        );
      },
    ));

    // 10. Recap: cover collage, highlights, confetti, Done / Replay.
    cards.add(_Card(
      gradient: const [Color(0xFF232526), Color(0xFF414345)],
      trackId: trackAt(0),
      duration: const Duration(milliseconds: 14000),
      reveal: const Duration(milliseconds: 9000),
      fx: _Fx.slideUp,
      build: (t, a) => Stack(
        children: [
          Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    _rise(t, 0.0, _big('Your ${s.year}', 30, Colors.white70)),
                    _rise(t, 0.06, _gradientText('in music', 40)),
                  ]),
                ),
                _pop(t, 0.1, _collage(a)),
              ]),
              const SizedBox(height: 22),
              _rise(t, 0.2, _recapRow(LucideIcons.clock, '${_fmt(s.totalMinutes)} minutes')),
              _rise(t, 0.28,
                  _recapRow(LucideIcons.music2,
                      '${_fmt(s.distinctTracks)} songs · ${_fmt(s.distinctArtists)} artists')),
              if (tt.isNotEmpty)
                _rise(t, 0.36, _recapRow(LucideIcons.star, 'Top song: ${tt.first.title}')),
              if (s.topArtists.isNotEmpty)
                _rise(t, 0.44,
                    _recapRow(LucideIcons.mic2, 'Top artist: ${s.topArtists.first.name}')),
              if (s.topGenres.isNotEmpty)
                _rise(t, 0.52, _recapRow(LucideIcons.disc3, 'Top genre: ${s.topGenres.first.name}')),
              _rise(t, 0.6, _recapRow(LucideIcons.sparkles, _personality(s))),
              const SizedBox(height: 26),
              _rise(
                t,
                0.7,
                Wrap(spacing: 12, runSpacing: 10, children: [
                  FilledButton.icon(
                    style: FilledButton.styleFrom(
                        backgroundColor: kAccent, foregroundColor: kAccentInk),
                    icon: const Icon(LucideIcons.check, size: 18),
                    label: const Text('Done'),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Colors.white54)),
                    icon: _sharing
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.ios_share, size: 18),
                    label: const Text('Share'),
                    onPressed: _sharing ? null : _share,
                  ),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Colors.white54)),
                    icon: const Icon(LucideIcons.refreshCw, size: 18),
                    label: const Text('Replay'),
                    onPressed: _restart,
                  ),
                ]),
              ),
            ],
          ),
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(painter: _ConfettiPainter(_p(t, 0.05, 0.75))),
            ),
          ),
        ],
      ),
    ));

    return cards;
  }

  // ------------------------------------------------------- set pieces ----
  /// Must be a direct child of the intro's Stack (Positioned needs a Stack
  /// parent), so the area size comes in from the LayoutBuilder around it.
  Widget _floatingCover(String id, int i, double t, double a, Size area) {
    // Covers drift up from below and bob gently behind the intro title.
    const xs = [0.62, 0.05, 0.72, 0.30, 0.50];
    const ys = [0.08, 0.62, 0.66, 0.80, 0.30];
    const rots = [0.12, -0.10, -0.06, 0.08, -0.14];
    final p = Curves.easeOutCubic.transform(_p(t, 0.05 + i * 0.07, 0.45 + i * 0.07));
    final size = 92.0 + (i % 2) * 18;
    final bob = math.sin((a + i * 0.21) * 2 * math.pi) * 8;
    return Positioned(
      left: area.width * xs[i],
      top: area.height * ys[i] + (1 - p) * 260 + bob,
      child: Opacity(
        opacity: 0.55 * p,
        child: Transform.rotate(
          angle: rots[i],
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [BoxShadow(color: Colors.black45, blurRadius: 18)],
            ),
            child: Cover(url: _cover(id), trackId: id, size: size, radius: 12),
          ),
        ),
      ),
    );
  }

  Widget _vinyl(String id, double t, double a) {
    // The record slides out of the sleeve, then keeps spinning.
    final out = Curves.easeOutCubic.transform(_p(t, 0.12, 0.42));
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: 310,
        height: 200,
        child: Stack(children: [
          Positioned(
            left: 10 + out * 105,
            top: 5,
            child: Transform.rotate(
              angle: a * 2 * math.pi * 8,
              child: SizedBox(
                width: 190,
                height: 190,
                child: Stack(alignment: Alignment.center, children: [
                  CustomPaint(size: const Size(190, 190), painter: _VinylPainter()),
                  ClipOval(child: Cover(url: _cover(id), trackId: id, size: 70, radius: 0)),
                  Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(color: Colors.black, shape: BoxShape.circle),
                  ),
                ]),
              ),
            ),
          ),
          Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 22, offset: Offset(6, 8))],
            ),
            child: Cover(url: _cover(id), trackId: id, size: 200, radius: 8),
          ),
        ]),
      ),
    );
  }

  Widget _bubble(double t, double a, int i, String name) {
    final pop = Curves.elasticOut.transform(_p(t, 0.12 + i * 0.1, 0.5 + i * 0.1));
    final bob = math.sin((a * 3 + i * 0.37) * 2 * math.pi) * 5;
    final size = (22 - i * 2.5).clamp(14, 22).toDouble();
    return Transform.translate(
      offset: Offset(0, bob),
      child: Transform.scale(
        scale: pop,
        child: Container(
          padding: EdgeInsets.symmetric(horizontal: size * 0.9, vertical: size * 0.5),
          decoration: BoxDecoration(
            color: i == 0 ? const Color(0xFF053d33) : Colors.white.withValues(alpha: 0.28),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(name,
              style: TextStyle(
                  color: i == 0 ? Colors.white : const Color(0xFF053d33),
                  fontSize: size,
                  fontWeight: FontWeight.w800)),
        ),
      ),
    );
  }

  Widget _monthChart(double t) {
    final mm = _s.monthMinutes;
    final maxV = mm.fold<int>(1, math.max);
    const h = 150.0;
    return SizedBox(
      height: h + 22,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (var i = 0; i < 12; i++)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2.5),
                child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                  Container(
                    height: math.max(
                        3,
                        h *
                            (mm[i] / maxV) *
                            Curves.easeOutBack.transform(_p(t, 0.05 + i * 0.03, 0.4 + i * 0.03))),
                    decoration: BoxDecoration(
                      color: i == _s.peakMonth
                          ? const Color(0xFF3a2d00)
                          : const Color(0xFF3a2d00).withValues(alpha: 0.28),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(_months[i][0],
                      style: TextStyle(
                          color: const Color(0xFF3a2d00)
                              .withValues(alpha: i == _s.peakMonth ? 1 : 0.6),
                          fontSize: 11,
                          fontWeight: FontWeight.w700)),
                ]),
              ),
            ),
        ],
      ),
    );
  }

  Widget _collage(double a) {
    final ids = _s.topTracks.take(4).map((t) => t.id).toList();
    if (ids.isEmpty) return const SizedBox.shrink();
    return Transform.rotate(
      angle: 0.08 + math.sin(a * 2 * math.pi) * 0.03,
      child: Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 20)],
        ),
        child: SizedBox(
          width: 112,
          height: 112,
          child: GridView.count(
            crossAxisCount: 2,
            mainAxisSpacing: 3,
            crossAxisSpacing: 3,
            physics: const NeverScrollableScrollPhysics(),
            padding: EdgeInsets.zero,
            children: [
              for (var i = 0; i < 4; i++)
                Cover(url: _cover(ids[i % ids.length]), trackId: ids[i % ids.length], size: 54, radius: 4),
            ],
          ),
        ),
      ),
    );
  }

  Widget _personalityBadge() {
    final (name, blurb, icon) = _personalityInfo(_s);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 20, 14),
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [kAccent, kAccent2]),
        borderRadius: BorderRadius.circular(18),
        boxShadow: [BoxShadow(color: kAccent.withValues(alpha: 0.45), blurRadius: 24)],
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: kAccentInk, size: 34),
        const SizedBox(width: 12),
        Flexible(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(name,
                style: const TextStyle(
                    color: kAccentInk, fontSize: 22, fontWeight: FontWeight.w900)),
            Text(blurb, style: const TextStyle(color: kAccentInk, fontSize: 13)),
          ]),
        ),
      ]),
    );
  }

  // ----------------------------------------------------- small pieces ----
  Widget _rise(double t, double start, Widget child) {
    final p = Curves.easeOutCubic.transform(_p(t, start, start + 0.16));
    return Opacity(
      opacity: p,
      child: Transform.translate(offset: Offset(0, 22 * (1 - p)), child: child),
    );
  }

  Widget _pop(double t, double start, Widget child) {
    final raw = _p(t, start, start + 0.22);
    return Opacity(
      opacity: raw.clamp(0.0, 1.0),
      child: Transform.scale(scale: 0.6 + 0.4 * Curves.easeOutBack.transform(raw), child: child),
    );
  }

  Widget _slideIn(double t, double start, Widget child) {
    final p = Curves.easeOutCubic.transform(_p(t, start, start + 0.15));
    return Opacity(
      opacity: p,
      child: Transform.translate(offset: Offset(60 * (1 - p), 0), child: child),
    );
  }

  Widget _big(String s, double size, Color color, {bool center = false, int maxLines = 1}) => Text(
        s,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
        textAlign: center ? TextAlign.center : TextAlign.start,
        style: TextStyle(color: color, fontSize: size, fontWeight: FontWeight.w900, height: 1.05),
      );

  Widget _gradientText(String s, double size) => ShaderMask(
        shaderCallback: (r) => const LinearGradient(
          colors: [kAccent2, Colors.white, Color(0xFFff8fd8)],
        ).createShader(r),
        child: Text(s,
            style: TextStyle(
                color: Colors.white, fontSize: size, fontWeight: FontWeight.w900, height: 1.05)),
      );

  Widget _label(String s, {bool dark = false}) => Text(s,
      style: TextStyle(
          color: dark ? Colors.black54 : Colors.white70,
          fontSize: 14,
          fontWeight: FontWeight.w800,
          letterSpacing: 2));

  Widget _pill(String s) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(999)),
        child: Text(s,
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 15)),
      );

  Widget _underline(double p) => Container(
        width: 180 * Curves.easeOutCubic.transform(p),
        height: 5,
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [kAccent, kAccent2]),
          borderRadius: BorderRadius.circular(3),
        ),
      );

  Widget _rankRow(int rank, String title, String sub, String? coverId,
      {bool round = false, double glow = 0}) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 5),
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.08 + 0.12 * glow),
        borderRadius: BorderRadius.circular(14),
        boxShadow: glow > 0
            ? [BoxShadow(color: kAccent2.withValues(alpha: 0.5 * glow), blurRadius: 24 * glow)]
            : null,
      ),
      child: Row(children: [
        SizedBox(
          width: 34,
          child: Text('$rank',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w900)),
        ),
        const SizedBox(width: 6),
        if (coverId != null)
          round
              ? ClipOval(child: Cover(url: _cover(coverId), trackId: coverId, size: 46, radius: 0))
              : Cover(url: _cover(coverId), trackId: coverId, size: 46, radius: 8),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
            Text(sub,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white70, fontSize: 13)),
          ]),
        ),
      ]),
    );
  }

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

  static String _fmt(int n) {
    final s = n.toString();
    final b = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
      b.write(s[i]);
    }
    return b.toString();
  }

  String _personality(RewindStats s) => _personalityInfo(s).$1;

  /// A light, derived "listening personality" from breadth vs. repetition.
  (String, String, IconData) _personalityInfo(RewindStats s) {
    if (s.totalPlays == 0 || s.distinctTracks == 0) {
      return ('The Listener', 'Music is always on', LucideIcons.headphones);
    }
    final repeatRatio = s.totalPlays / s.distinctTracks; // higher = more replays
    final breadth = s.distinctArtists;
    if (repeatRatio >= 4) {
      return ('The Replayer', 'When you love a song, you really love it', LucideIcons.repeat);
    }
    if (breadth >= 60) {
      return ('The Explorer', 'Always hunting for something new', LucideIcons.sparkles);
    }
    if (breadth >= 25) {
      return ('The Adventurer', 'A little bit of everything', LucideIcons.radio);
    }
    if (repeatRatio >= 2) {
      return ('The Loyalist', 'You know what you like', LucideIcons.heart);
    }
    return ('The Specialist', 'A carefully curated taste', LucideIcons.disc3);
  }
}

// --------------------------------------------------------- share card ----

/// The shareable recap image: laid out at 360x640 and rasterised at 3x, so the
/// PNG is 1080x1920 (a phone story). Top songs, top artist, minutes listened,
/// listening personality, the year and Relay branding.
class _ShareCard extends StatelessWidget {
  static const double scale = 3;
  static const Size size = Size(360, 640);

  final RewindStats stats;
  final String Function(String trackId) coverUrl;
  final (String, String, IconData) personality;
  const _ShareCard({required this.stats, required this.coverUrl, required this.personality});

  static String _fmt(int n) {
    final s = n.toString();
    final b = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
      b.write(s[i]);
    }
    return b.toString();
  }

  Widget _cover(String id, double side) => ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image(
          image: CachedNetworkImageProvider(coverUrl(id), cacheKey: coverCacheKey(coverUrl(id))),
          width: side,
          height: side,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => Container(
            width: side,
            height: side,
            color: Colors.white12,
            child: Icon(Icons.music_note, size: side * 0.5, color: Colors.white54),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final (pName, pBlurb, pIcon) = personality;
    final top = stats.topTracks.take(5).toList();
    const label = TextStyle(
        color: Colors.white60, fontSize: 9, fontWeight: FontWeight.w800, letterSpacing: 1.6);
    return MediaQuery(
      // Fixed layout regardless of the device's text scale.
      data: const MediaQueryData(size: size, textScaler: TextScaler.noScaling),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Material(
          type: MaterialType.transparency,
          child: Container(
            width: size.width,
            height: size.height,
            padding: const EdgeInsets.fromLTRB(24, 30, 24, 22),
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0xFF141E30), Color(0xFF243B55), Color(0xFF3a1c71)],
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  const Icon(LucideIcons.sparkles, size: 13, color: kAccent2),
                  const SizedBox(width: 6),
                  Text('RELAY REWIND', style: label.copyWith(color: Colors.white)),
                ]),
                const SizedBox(height: 6),
                Text('${stats.year}',
                    style: const TextStyle(
                        color: Colors.white, fontSize: 64, fontWeight: FontWeight.w900, height: 1)),
                ShaderMask(
                  shaderCallback: (r) => const LinearGradient(
                    colors: [kAccent2, Colors.white, Color(0xFFff8fd8)],
                  ).createShader(r),
                  child: const Text('in music',
                      style: TextStyle(
                          color: Colors.white, fontSize: 30, fontWeight: FontWeight.w900, height: 1.1)),
                ),
                const SizedBox(height: 18),
                Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Text('MINUTES LISTENED', style: label),
                      Text(_fmt(stats.totalMinutes),
                          style: const TextStyle(
                              color: Colors.white, fontSize: 30, fontWeight: FontWeight.w900)),
                    ]),
                  ),
                  if (stats.topArtists.isNotEmpty)
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const Text('TOP ARTIST', style: label),
                        Text(stats.topArtists.first.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 18,
                                fontWeight: FontWeight.w800,
                                height: 1.15)),
                      ]),
                    ),
                ]),
                const SizedBox(height: 18),
                const Text('TOP SONGS', style: label),
                const SizedBox(height: 6),
                for (var i = 0; i < top.length; i++)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(children: [
                      SizedBox(
                        width: 20,
                        child: Text('${i + 1}',
                            style: const TextStyle(
                                color: Colors.white, fontSize: 15, fontWeight: FontWeight.w900)),
                      ),
                      _cover(top[i].id, 36),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(top[i].title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700)),
                          Text(top[i].artist,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(color: Colors.white70, fontSize: 11)),
                        ]),
                      ),
                    ]),
                  ),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [kAccent, kAccent2]),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(children: [
                    Icon(pIcon, color: kAccentInk, size: 26),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(pName,
                            style: const TextStyle(
                                color: kAccentInk, fontSize: 16, fontWeight: FontWeight.w900)),
                        Text(pBlurb,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: kAccentInk, fontSize: 10.5)),
                      ]),
                    ),
                  ]),
                ),
                const SizedBox(height: 16),
                Row(children: [
                  const Image(image: AssetImage('assets/logo.png'), width: 20, height: 20),
                  const SizedBox(width: 8),
                  const Text('Relay',
                      style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w800)),
                  const Spacer(),
                  Text('${_fmt(stats.distinctTracks)} songs · ${_fmt(stats.distinctArtists)} artists',
                      style: const TextStyle(color: Colors.white60, fontSize: 10)),
                ]),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ----------------------------------------------------------- painters ----

/// Card background: the gradient, plus the card's cover blurred and slowly
/// zooming (Ken Burns) underneath a tinted overlay.
class _Backdrop extends StatelessWidget {
  final List<Color> gradient;
  final String? coverUrl;
  final Animation<double> ambient;
  const _Backdrop({super.key, required this.gradient, required this.coverUrl, required this.ambient});

  @override
  Widget build(BuildContext context) {
    return Stack(fit: StackFit.expand, children: [
      DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
              begin: Alignment.topLeft, end: Alignment.bottomRight, colors: gradient),
        ),
      ),
      if (coverUrl != null)
        AnimatedBuilder(
          animation: ambient,
          builder: (context, child) {
            final ph = ambient.value * 2 * math.pi;
            return Transform.translate(
              offset: Offset(math.sin(ph) * 18, math.cos(ph) * 12),
              child: Transform.scale(scale: 1.25 + 0.08 * math.sin(ph), child: child),
            );
          },
          // RepaintBoundary: the blur is rasterized once; only the transform animates.
          child: RepaintBoundary(
            child: ImageFiltered(
              imageFilter: ImageFilter.blur(sigmaX: 26, sigmaY: 26),
              child: Image(
                image: ResizeImage(
                    CachedNetworkImageProvider(coverUrl!, cacheKey: coverCacheKey(coverUrl!)),
                    width: 220),
                fit: BoxFit.cover,
                errorBuilder: (context, e, st) => const SizedBox.shrink(),
              ),
            ),
          ),
        ),
      if (coverUrl != null)
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                gradient.first.withValues(alpha: 0.78),
                gradient.last.withValues(alpha: 0.7),
              ],
            ),
          ),
        ),
      const DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            radius: 1.1,
            colors: [Colors.transparent, Colors.black38],
          ),
        ),
      ),
    ]);
  }
}

/// Soft glowing blobs drifting on slow Lissajous paths.
class _BlobPainter extends CustomPainter {
  final double phase;
  final List<Color> palette;
  _BlobPainter(this.phase, this.palette);

  @override
  void paint(Canvas canvas, Size size) {
    final ph = phase * 2 * math.pi;
    final blobs = [
      (0.2, 0.25, 0.55, 1.0, 1.0, Colors.white.withValues(alpha: 0.10)),
      (0.85, 0.7, 0.6, 0.7, 1.3, palette.last.withValues(alpha: 0.35)),
      (0.5, 0.95, 0.5, 1.4, 0.8, palette.first.withValues(alpha: 0.30)),
      (0.9, 0.1, 0.4, 0.9, 1.7, kAccent2.withValues(alpha: 0.10)),
    ];
    for (final (x, y, r, fx, fy, c) in blobs) {
      final center = Offset(
        size.width * (x + 0.12 * math.sin(ph * fx)),
        size.height * (y + 0.08 * math.cos(ph * fy)),
      );
      final radius = size.width * r;
      canvas.drawCircle(
        center,
        radius,
        Paint()
          ..shader = RadialGradient(colors: [c, c.withValues(alpha: 0)])
              .createShader(Rect.fromCircle(center: center, radius: radius)),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _BlobPainter old) => old.phase != phase || old.palette != palette;
}

/// Expanding, fading rings around the top artist.
class _RingsPainter extends CustomPainter {
  final double phase;
  _RingsPainter(this.phase);

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    const base = 85.0;
    for (var i = 0; i < 3; i++) {
      final q = (phase * 4 + i / 3) % 1.0;
      canvas.drawCircle(
        c,
        base + q * (size.width / 2 - base),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..color = Colors.white.withValues(alpha: 0.5 * (1 - q)),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _RingsPainter old) => old.phase != phase;
}

/// A vinyl record: black disc, grooves, and a sheen.
class _VinylPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.width / 2;
    canvas.drawCircle(c, r, Paint()..color = const Color(0xFF111111));
    final groove = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.8
      ..color = Colors.white.withValues(alpha: 0.07);
    for (var g = r * 0.42; g < r * 0.97; g += 3.2) {
      canvas.drawCircle(c, g, groove);
    }
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = SweepGradient(colors: [
          Colors.transparent,
          Colors.white.withValues(alpha: 0.16),
          Colors.transparent,
          Colors.white.withValues(alpha: 0.10),
          Colors.transparent,
        ]).createShader(Rect.fromCircle(center: c, radius: r)),
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// A one-shot confetti burst falling across the recap card.
class _ConfettiPainter extends CustomPainter {
  final double progress; // 0..1
  _ConfettiPainter(this.progress);

  static const _colors = [
    Color(0xFF22d3ee),
    Color(0xFF67e8f9),
    Color(0xFFff8fd8),
    Color(0xFFffd200),
    Color(0xFF38ef7d),
    Colors.white,
  ];

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0 || progress >= 1) return;
    final rnd = math.Random(7);
    final fade = progress > 0.8 ? (1 - progress) / 0.2 : 1.0;
    for (var i = 0; i < 70; i++) {
      final x0 = rnd.nextDouble();
      final speed = 0.7 + rnd.nextDouble() * 0.8;
      final sway = rnd.nextDouble() * 2 * math.pi;
      final spin = (rnd.nextDouble() - 0.5) * 14;
      final color = _colors[rnd.nextInt(_colors.length)];
      final y = -0.08 + progress * speed * 1.25;
      if (y > 1.05) continue;
      final x = x0 + math.sin(progress * 6 + sway) * 0.04;
      canvas.save();
      canvas.translate(x * size.width, y * size.height);
      canvas.rotate(progress * spin);
      canvas.drawRect(
        const Rect.fromLTWH(-4, -2.5, 8, 5),
        Paint()..color = color.withValues(alpha: fade),
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _ConfettiPainter old) => old.progress != progress;
}

/// Four little bars bouncing in the top bar while music plays.
class _Equalizer extends StatelessWidget {
  final double phase;
  const _Equalizer({required this.phase});
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 22,
      height: 16,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          for (var i = 0; i < 4; i++)
            Container(
              width: 3.5,
              height: 4 + 12 * (0.5 + 0.5 * math.sin(phase * 2 * math.pi * (9 + i * 3) + i)).abs(),
              decoration: BoxDecoration(
                  color: kAccent2, borderRadius: BorderRadius.circular(2)),
            ),
        ],
      ),
    );
  }
}
