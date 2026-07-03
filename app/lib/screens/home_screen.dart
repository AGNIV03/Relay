import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_state.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import 'album_detail_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  WrappedStats? _stats;
  List<Track> _recent = [];
  List<Track> _most = [];
  List<Album> _added = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<Api>();
    final results = await Future.wait([
      api.statsMe().catchError((_) => WrappedStats(
          totalPlays: 0,
          totalMinutes: 0,
          distinctTracks: 0,
          topArtists: [],
          topGenres: [],
          topTracks: [])),
      api.recentlyPlayed().catchError((_) => <Track>[]),
      api.mostPlayed().catchError((_) => <Track>[]),
      api.recentAlbums().catchError((_) => <Album>[]),
    ]);
    if (!mounted) return;
    setState(() {
      _stats = results[0] as WrappedStats;
      _recent = results[1] as List<Track>;
      _most = results[2] as List<Track>;
      _added = results[3] as List<Album>;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final name = context.watch<AppState>().user?.username ?? "";
    final hasActivity = (_stats?.totalPlays ?? 0) > 0;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          Text.rich(TextSpan(children: [
            const TextSpan(text: "Welcome back, ", style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            TextSpan(text: name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: kAccent)),
          ])),
          const SizedBox(height: 16),

          if (hasActivity && _stats != null) ...[
            const _Header(icon: LucideIcons.sparkles, text: "Your listening"),
            _StatsCard(stats: _stats!),
            const SizedBox(height: 22),
          ],

          if (_recent.isNotEmpty) ...[
            const _Header(icon: LucideIcons.clock, text: "Recently played"),
            _TrackRow(tracks: _recent),
            const SizedBox(height: 22),
          ],

          if (_most.isNotEmpty) ...[
            const _Header(icon: LucideIcons.music2, text: "Most played"),
            _TrackRow(tracks: _most),
            const SizedBox(height: 22),
          ],

          const _Header(icon: LucideIcons.disc3, text: "Recently added"),
          if (_loading)
            const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator()))
          else if (_added.isEmpty)
            const Text("Your library is empty.", style: TextStyle(color: kMuted))
          else
            _AlbumRow(albums: _added),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final IconData icon;
  final String text;
  const _Header({required this.icon, required this.text});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(children: [
          Icon(icon, size: 18, color: kAccent),
          const SizedBox(width: 8),
          Text(text, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
        ]),
      );
}

class _StatsCard extends StatelessWidget {
  final WrappedStats stats;
  const _StatsCard({required this.stats});
  @override
  Widget build(BuildContext context) {
    Widget num(String v, String l) => Column(children: [
          Text(v, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: kAccent)),
          Text(l, style: const TextStyle(fontSize: 11, color: kMuted)),
        ]);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: kBorder),
        gradient: const LinearGradient(colors: [kPanel2, kPanel], begin: Alignment.topLeft, end: Alignment.bottomRight),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
          num("${stats.totalPlays}", "plays"),
          num("${stats.totalMinutes}", "minutes"),
          num("${stats.distinctTracks}", "songs"),
        ]),
        if (stats.topArtists.isNotEmpty) ...[
          const SizedBox(height: 14),
          const Text("TOP ARTISTS", style: TextStyle(fontSize: 10, color: kMuted, letterSpacing: 1)),
          const SizedBox(height: 4),
          ...stats.topArtists.take(3).toList().asMap().entries.map((e) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 1),
                child: Row(children: [
                  Text("${e.key + 1}  ", style: const TextStyle(color: kAccent, fontSize: 13)),
                  Expanded(child: Text(e.value.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
                ]),
              )),
        ],
        if (stats.topGenres.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final g in stats.topGenres.take(4))
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(20), border: Border.all(color: kBorder)),
                child: Text(g.name, style: const TextStyle(fontSize: 11, color: kMuted)),
              ),
          ]),
        ],
      ]),
    );
  }
}

class _TrackRow extends StatelessWidget {
  final List<Track> tracks;
  const _TrackRow({required this.tracks});
  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final player = context.read<PlayerModel>();
    return _ArrowScroller(
      height: 178,
      builder: (controller) => ListView.separated(
        controller: controller,
        scrollDirection: Axis.horizontal,
        itemCount: tracks.length,
        separatorBuilder: (_, _) => const SizedBox(width: 10),
        itemBuilder: (_, i) {
          final t = tracks[i];
          return GestureDetector(
            onTap: () => player.playQueue(tracks, start: i),
            child: SizedBox(
              width: 124,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Cover(url: api.trackCoverUrl(t.id), size: 124, radius: 12),
                const SizedBox(height: 6),
                Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                Text(t.playCount != null ? "${t.playCount} plays" : t.artistName,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: kMuted)),
              ]),
            ),
          );
        },
      ),
    );
  }
}

class _AlbumRow extends StatelessWidget {
  final List<Album> albums;
  const _AlbumRow({required this.albums});
  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return _ArrowScroller(
      height: 178,
      builder: (controller) => ListView.separated(
        controller: controller,
        scrollDirection: Axis.horizontal,
        itemCount: albums.length,
        separatorBuilder: (_, _) => const SizedBox(width: 10),
        itemBuilder: (_, i) {
          final a = albums[i];
          return GestureDetector(
            onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => AlbumDetailScreen(albumId: a.id))),
            child: SizedBox(
              width: 124,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Cover(url: api.albumCoverUrl(a.id), size: 124, radius: 12),
                const SizedBox(height: 6),
                Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                Text(a.artist?.name ?? "", maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: kMuted)),
              ]),
            ),
          );
        },
      ),
    );
  }
}

/// Wraps a horizontal list with left/right scroll-arrow buttons (desktop only —
/// touch platforms just swipe). The [builder] gets the ScrollController to attach.
class _ArrowScroller extends StatefulWidget {
  final double height;
  final Widget Function(ScrollController) builder;
  const _ArrowScroller({required this.height, required this.builder});
  @override
  State<_ArrowScroller> createState() => _ArrowScrollerState();
}

class _ArrowScrollerState extends State<_ArrowScroller> {
  final _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _scrollBy(double delta) {
    if (!_controller.hasClients) return;
    final target = (_controller.offset + delta).clamp(0.0, _controller.position.maxScrollExtent);
    _controller.animateTo(target,
        duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
  }

  bool get _isDesktop =>
      !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

  Widget _arrow(IconData icon, VoidCallback onTap) => Material(
        color: kPanel2,
        shape: const CircleBorder(),
        elevation: 4,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Padding(padding: const EdgeInsets.all(6), child: Icon(icon, size: 20)),
        ),
      );

  @override
  Widget build(BuildContext context) {
    if (!_isDesktop) {
      return SizedBox(height: widget.height, child: widget.builder(_controller));
    }
    return SizedBox(
      height: widget.height,
      child: Stack(
        children: [
          Positioned.fill(child: widget.builder(_controller)),
          Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            child: Center(child: _arrow(Icons.chevron_left, () => _scrollBy(-420))),
          ),
          Positioned(
            right: 0,
            top: 0,
            bottom: 0,
            child: Center(child: _arrow(Icons.chevron_right, () => _scrollBy(420))),
          ),
        ],
      ),
    );
  }
}
