import 'dart:math' show Random;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../downloads.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/mini_player.dart';
import '../widgets/track_tile.dart';

/// Shared "Retry connection" action used across the offline screens.
Future<void> _retry(BuildContext context) async {
  final state = context.read<AppState>();
  final messenger = ScaffoldMessenger.of(context);
  final ok = await state.retryConnect();
  if (!ok) {
    messenger.showSnackBar(const SnackBar(content: Text('Still offline')));
  }
}

enum _SortField { random, title, artist, album }

List<Track> _sortTracks(List<Track> list, _SortField field, bool asc, int seed) {
  if (field == _SortField.random) return List<Track>.of(list)..shuffle(Random(seed));
  String key(Track t) {
    switch (field) {
      case _SortField.random:
        return '';
      case _SortField.title:
        return t.title.toLowerCase();
      case _SortField.artist:
        return t.artistName.toLowerCase();
      case _SortField.album:
        return t.albumTitle.toLowerCase();
    }
  }

  final l = List<Track>.of(list)..sort((a, b) => key(a).compareTo(key(b)));
  return asc ? l : l.reversed.toList();
}

/// Offline home: mirrors the online layout — a Songs tab (sortable) and a
/// Playlists tab — but plays only locally-stored audio. Like buttons and the
/// per-track menu are hidden because their actions need the server.
class OfflineRoot extends StatefulWidget {
  const OfflineRoot({super.key});

  @override
  State<OfflineRoot> createState() => _OfflineRootState();
}

class _OfflineRootState extends State<OfflineRoot> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  _SortField _sortField = _SortField.random;
  bool _sortAsc = true;
  int _shuffleSeed = DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    _tabs.addListener(() => setState(() {})); // show/hide the sort action per tab
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Widget _sortButton() {
    const labels = {
      _SortField.random: 'Shuffle',
      _SortField.title: 'Title',
      _SortField.artist: 'Artist',
      _SortField.album: 'Album',
    };
    return PopupMenuButton<_SortField>(
      icon: const Icon(LucideIcons.arrowDownUp, size: 20),
      tooltip: 'Sort',
      color: kPanel2,
      onSelected: (f) => setState(() {
        if (f == _SortField.random) {
          _sortField = _SortField.random;
          _shuffleSeed = DateTime.now().millisecondsSinceEpoch;
        } else if (_sortField == f) {
          _sortAsc = !_sortAsc;
        } else {
          _sortField = f;
          _sortAsc = true;
        }
      }),
      itemBuilder: (_) => [
        for (final e in labels.entries)
          PopupMenuItem(
            value: e.key,
            child: Row(children: [
              Expanded(
                child: Text(e.value,
                    style: TextStyle(color: _sortField == e.key ? kAccent : null)),
              ),
              if (_sortField == e.key)
                Icon(
                    e.key == _SortField.random
                        ? LucideIcons.shuffle
                        : (_sortAsc ? LucideIcons.arrowUp : LucideIcons.arrowDown),
                    size: 15,
                    color: kAccent),
            ]),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadManager>();
    final tracks = _sortTracks(downloads.offlineTracks, _sortField, _sortAsc, _shuffleSeed);
    final playlists = downloads.offlinePlaylists;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Offline'),
        actions: [
          if (_tabs.index == 0) _sortButton(),
          IconButton(
            tooltip: 'Retry connection',
            icon: const Icon(LucideIcons.refreshCw, size: 20),
            onPressed: () => _retry(context),
          ),
          const SizedBox(width: 4),
        ],
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: kAccent,
          labelColor: kAccent,
          unselectedLabelColor: kMuted,
          tabs: const [Tab(text: 'Songs'), Tab(text: 'Playlists')],
        ),
      ),
      bottomNavigationBar: const SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, children: [MiniPlayer()]),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          // ---- Songs ----
          Column(
            children: [
              const _OfflineBanner(),
              Expanded(
                child: tracks.isEmpty
                    ? const _EmptyNote('No downloaded songs')
                    : ListView.builder(
                        itemCount: tracks.length,
                        itemBuilder: (_, i) => TrackTile(
                          tracks: tracks,
                          index: i,
                          showLike: false,
                          showMenu: false,
                        ),
                      ),
              ),
            ],
          ),
          // ---- Playlists ----
          playlists.isEmpty
              ? const _EmptyNote('No downloaded playlists')
              : GridView.builder(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 180,
                    mainAxisSpacing: 24,
                    crossAxisSpacing: 22,
                    childAspectRatio: 0.76,
                  ),
                  itemCount: playlists.length,
                  itemBuilder: (context, i) {
                    final pl = playlists[i];
                    return InkWell(
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => OfflinePlaylistScreen(playlist: pl)),
                      ),
                      borderRadius: BorderRadius.circular(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AspectRatio(
                            aspectRatio: 1,
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(12),
                              child: Cover(trackId: pl.tracks.first.id, size: 180, radius: 12),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(pl.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                          Text('${pl.tracks.length} songs',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 11.5, color: kMuted)),
                        ],
                      ),
                    );
                  },
                ),
        ],
      ),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner();
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: kAccent.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
        ),
        child: const Row(children: [
          Icon(LucideIcons.download, size: 18, color: kAccent),
          SizedBox(width: 10),
          Expanded(
            child: Text("You're offline — playing your downloaded music.",
                style: TextStyle(color: kAccent, fontSize: 13)),
          ),
        ]),
      );
}

class _EmptyNote extends StatelessWidget {
  final String text;
  const _EmptyNote(this.text);
  @override
  Widget build(BuildContext context) =>
      Center(child: Text(text, style: const TextStyle(color: kMuted)));
}

/// A single downloaded playlist, playable offline.
class OfflinePlaylistScreen extends StatelessWidget {
  final OfflinePlaylist playlist;
  const OfflinePlaylistScreen({super.key, required this.playlist});

  @override
  Widget build(BuildContext context) {
    final tracks = playlist.tracks;
    return Scaffold(
      appBar: AppBar(title: Text(playlist.name)),
      bottomNavigationBar: const SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, children: [MiniPlayer()]),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              FilledButton.icon(
                icon: const Icon(Icons.play_arrow),
                label: const Text('Play'),
                onPressed: tracks.isEmpty
                    ? null
                    : () => context.read<PlayerModel>().playQueue(tracks),
              ),
              const SizedBox(width: 10),
              OutlinedButton.icon(
                icon: const Icon(Icons.shuffle, size: 18),
                label: const Text('Shuffle'),
                onPressed: tracks.isEmpty
                    ? null
                    : () => context.read<PlayerModel>().shuffleAndPlay(tracks),
              ),
              const SizedBox(width: 10),
              Text('${tracks.length} songs', style: const TextStyle(color: kMuted)),
            ]),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: tracks.length,
              itemBuilder: (_, i) =>
                  TrackTile(tracks: tracks, index: i, showLike: false, showMenu: false),
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown when offline with nothing downloaded — there's nothing to play.
class OfflineEmptyScreen extends StatelessWidget {
  const OfflineEmptyScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(LucideIcons.x, size: 48, color: kMuted),
              const SizedBox(height: 16),
              const Text("You're offline",
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text(
                'No downloaded songs are available. Connect to the internet to '
                'stream, or download songs while online to listen offline.',
                textAlign: TextAlign.center,
                style: TextStyle(color: kMuted),
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                icon: const Icon(LucideIcons.refreshCw, size: 18),
                label: const Text('Retry connection'),
                onPressed: () => _retry(context),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
