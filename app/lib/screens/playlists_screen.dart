import 'dart:async';
import 'dart:math' show Random;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../events.dart';
import '../models.dart';
import '../theme.dart';
import 'liked_songs_screen.dart';
import 'playlist_detail_screen.dart';

enum _PlOrder { shuffle, name, songs }

class PlaylistsScreen extends StatefulWidget {
  const PlaylistsScreen({super.key});
  @override
  State<PlaylistsScreen> createState() => _PlaylistsScreenState();
}

class _PlaylistsScreenState extends State<PlaylistsScreen> {
  late Future<List<Playlist>> _future;
  final _searchController = TextEditingController();
  String _q = '';
  Timer? _sync;
  // Default order is random. A fixed per-session seed keeps that random order
  // stable across rebuilds (so it doesn't reshuffle on every frame or poll);
  // picking "Shuffle" in the sort menu reshuffles.
  int _shuffleSeed = DateTime.now().millisecondsSinceEpoch;
  _PlOrder _order = _PlOrder.shuffle;
  bool _asc = true;

  List<Playlist> _ordered(List<Playlist> list) {
    final l = List<Playlist>.of(list);
    switch (_order) {
      case _PlOrder.shuffle:
        return l..shuffle(Random(_shuffleSeed));
      case _PlOrder.name:
        l.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      case _PlOrder.songs:
        l.sort((a, b) => b.trackCount.compareTo(a.trackCount)); // most first
    }
    return _asc ? l : l.reversed.toList();
  }

  Widget _sortButton() {
    const labels = {
      _PlOrder.shuffle: 'Shuffle',
      _PlOrder.name: 'Name',
      _PlOrder.songs: 'Most songs',
    };
    return PopupMenuButton<_PlOrder>(
      icon: const Icon(LucideIcons.arrowDownUp, size: 20),
      tooltip: 'Sort',
      color: kPanel2,
      onSelected: (o) => setState(() {
        if (o == _PlOrder.shuffle) {
          _order = o;
          _shuffleSeed = DateTime.now().millisecondsSinceEpoch;
        } else if (o == _order) {
          _asc = !_asc;
        } else {
          _order = o;
          _asc = true;
        }
      }),
      itemBuilder: (_) => [
        for (final e in labels.entries)
          PopupMenuItem(
            value: e.key,
            child: Row(children: [
              Expanded(
                child: Text(e.value, style: TextStyle(color: _order == e.key ? kAccent : null)),
              ),
              if (_order == e.key)
                Icon(
                    e.key == _PlOrder.shuffle
                        ? LucideIcons.shuffle
                        : (_asc ? LucideIcons.arrowUp : LucideIcons.arrowDown),
                    size: 15,
                    color: kAccent),
            ]),
          ),
      ],
    );
  }

  @override
  void initState() {
    super.initState();
    _load();
    playlistsChanged.addListener(_reload); // refresh when a playlist is created/deleted elsewhere
    // Poll for cross-device sync (a playlist created on another device appears here).
    _sync = Timer.periodic(const Duration(seconds: 8), (_) => _reload());
  }

  @override
  void dispose() {
    _sync?.cancel();
    _searchController.dispose();
    playlistsChanged.removeListener(_reload);
    super.dispose();
  }

  String _sig = '';

  /// Background sync: fetch, and only rebuild the grid if the list changed.
  Future<void> _reload() async {
    try {
      final pls = await context.read<Api>().playlists();
      final sig = pls.map((p) => '${p.id}|${p.name}|${p.trackCount}').join(';');
      if (!mounted || sig == _sig) return;
      _sig = sig;
      setState(() => _future = Future.value(pls));
    } catch (_) {}
  }

  void _load() => _future = context.read<Api>().playlists()
    ..then((pls) => _sig = pls.map((p) => '${p.id}|${p.name}|${p.trackCount}').join(';'))
        .ignore();

  Future<void> _create() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New playlist'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Playlist name'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (name != null && name.isNotEmpty && mounted) {
      await context.read<Api>().createPlaylist(name);
      if (mounted) setState(_load);
    }
  }

  Future<void> _delete(Playlist pl) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete "${pl.name}"?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok == true && mounted) {
      await context.read<Api>().deletePlaylist(pl.id);
      if (mounted) setState(_load);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton(
        onPressed: _create,
        child: const Icon(Icons.add),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 4, 4),
            child: Row(children: [
              Expanded(
                child: TextField(
              controller: _searchController,
              onChanged: (v) => setState(() => _q = v.trim()),
              decoration: InputDecoration(
                prefixIcon: const Icon(LucideIcons.search, size: 18),
                hintText: 'Search playlists…',
                suffixIcon: _q.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(LucideIcons.x, size: 18),
                        onPressed: () {
                          _searchController.clear();
                          setState(() => _q = '');
                        },
                      ),
              ),
                ),
              ),
              _sortButton(),
            ]),
          ),
          Expanded(
            child: FutureBuilder<List<Playlist>>(
              future: _future,
              builder: (context, snap) {
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final ql = _q.toLowerCase();
                final playlists = _ordered(ql.isEmpty
                    ? snap.data!
                    : snap.data!.where((p) => p.name.toLowerCase().contains(ql)).toList());
                // The permanent Liked Songs tile shows when not filtering (or if it matches).
                final showLiked = ql.isEmpty || 'liked songs'.contains(ql);
                return GridView.builder(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 90),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 180,
                    mainAxisSpacing: 24,
                    crossAxisSpacing: 22,
                    childAspectRatio: 0.76,
                  ),
                  itemCount: playlists.length + (showLiked ? 1 : 0),
                  itemBuilder: (context, idx) {
                    if (showLiked && idx == 0) {
                return _Tile(
                  title: 'Liked Songs',
                  subtitle: 'Your favourites',
                  cover: Container(
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(colors: [kAccent, kAccent2]),
                    ),
                    child: const Center(
                      child: Icon(LucideIcons.heart, fill: 1, size: 48, color: kAccentInk),
                    ),
                  ),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const LikedSongsScreen()),
                  ),
                );
              }
              final pl = playlists[idx - (showLiked ? 1 : 0)];
              return _Tile(
                title: pl.name,
                subtitle: '${pl.trackCount} ${pl.trackCount == 1 ? 'song' : 'songs'}',
                cover: Image.network(
                  context.read<Api>().playlistCoverUrl(pl.id),
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => Container(
                    color: kPanel2,
                    child: const Center(child: Icon(Icons.music_note, color: kMuted, size: 40)),
                  ),
                ),
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => PlaylistDetailScreen(playlistId: pl.id, name: pl.name),
                  ));
                  if (mounted) setState(_load); // refresh cover/order on return
                },
                onLongPress: () => _delete(pl),
              );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  final String title;
  final String subtitle;
  final Widget cover;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  const _Tile({
    required this.title,
    required this.subtitle,
    required this.cover,
    required this.onTap,
    this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      borderRadius: BorderRadius.circular(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: cover,
            ),
          ),
          const SizedBox(height: 8),
          Text(title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
          Text(subtitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: kMuted)),
        ],
      ),
    );
  }
}
