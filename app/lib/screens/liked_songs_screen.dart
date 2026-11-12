import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../format.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/playlist_actions.dart';
import '../widgets/track_selection.dart';
import '../widgets/track_sort.dart';
import '../widgets/track_tile.dart';

/// The permanent "Liked Songs" playlist (backed by the likes table).
class LikedSongsScreen extends StatefulWidget {
  const LikedSongsScreen({super.key});
  @override
  State<LikedSongsScreen> createState() => _LikedSongsScreenState();
}

class _LikedSongsScreenState extends State<LikedSongsScreen> {
  Future<Playlist> _load() => context.read<Api>().liked();
  late Future<Playlist> _future = _load();

  // Multi-select: long-press a song (right-click on desktop too).
  final Set<String> _selected = {};

  void _toggleSelect(Track t) => setState(() {
        if (!_selected.remove(t.id)) _selected.add(t.id);
      });

  String _songs(int n) => '$n ${n == 1 ? 'song' : 'songs'}';

  List<Track> _picked(List<Track> shown) => shown.where((t) => _selected.contains(t.id)).toList();

  Future<void> _bulkQueue(List<Track> shown) async {
    final picked = _picked(shown);
    final messenger = ScaffoldMessenger.of(context);
    await context.read<PlayerModel>().addAllToQueue(picked);
    messenger.showSnackBar(SnackBar(
        content: Text('Added ${_songs(picked.length)} to the queue'),
        duration: const Duration(seconds: 2)));
    if (mounted) setState(_selected.clear);
  }

  Future<void> _bulkAddTo(List<Track> shown) async {
    final picked = _picked(shown);
    final api = context.read<Api>();
    final messenger = ScaffoldMessenger.of(context);
    final target = await pickPlaylist(context, title: 'Add ${_songs(picked.length)} to playlist');
    if (target == null) return;
    try {
      final added = await api.addManyToPlaylist(target.id, [for (final t in picked) t.id]);
      final skipped = picked.length - added;
      messenger.showSnackBar(SnackBar(
          content: Text('Added $added to ${target.name}'
              '${skipped > 0 ? ' ($skipped already there)' : ''}')));
      if (mounted) setState(_selected.clear);
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't add to playlist")));
    }
  }

  /// Unlike the selection (there is no bulk endpoint; one call per song).
  Future<void> _bulkUnlike(List<Track> shown) async {
    final picked = _picked(shown);
    final api = context.read<Api>();
    final appState = context.read<AppState>();
    final messenger = ScaffoldMessenger.of(context);
    var removed = 0;
    for (final t in picked) {
      try {
        await api.unlike(t.id);
        removed++;
      } catch (_) {}
    }
    await appState.reloadLiked();
    messenger.showSnackBar(SnackBar(content: Text('Removed ${_songs(removed)} from Liked Songs')));
    if (mounted) {
      setState(() {
        _selected.clear();
        _future = _load();
      });
    }
  }

  // Remembered shuffle toggle, like playlists. The key matches the offline copy
  // of Liked Songs (download source "liked"), so the setting follows it offline.
  bool _shufflePref = false;
  static const _shuffleKey = 'pl_shuffle_liked';

  // Remembered ordering ("Date added" here = when you liked it).
  final _sort = TrackSortState();

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (mounted) setState(() => _shufflePref = p.getBool(_shuffleKey) ?? false);
    });
    _sort.load('liked').then((_) {
      if (mounted) setState(() {});
    });
  }

  Future<void> _toggleShufflePref() async {
    setState(() => _shufflePref = !_shufflePref);
    final p = await SharedPreferences.getInstance();
    await p.setBool(_shuffleKey, _shufflePref);
  }

  @override
  Widget build(BuildContext context) {
    // Re-fetch whenever the set of liked tracks changes.
    context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Liked Songs'),
        actions: [
          TrackSortButton(
            state: _sort,
            onSelected: (o) {
              setState(() => _sort.pick(o));
              _sort.save('liked');
            },
          ),
        ],
      ),
      body: FutureBuilder<Playlist>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tracks = sortTracks(snap.data!.tracks, _sort.order, _sort.asc,
              addedAt: snap.data!.addedAt);
          if (tracks.isEmpty) {
            return const Center(
              child: Text('Songs you like will show up here.\nTap the ♥ on any track.',
                  textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
            );
          }
          final totalSec = totalDurationSeconds(tracks.map((t) => t.duration));
          final selecting = _selected.isNotEmpty;
          return Column(
            children: [
              // Cover header (matches the playlist detail layout).
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
                child: Row(children: [
                  Container(
                    width: 110,
                    height: 110,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      gradient: const LinearGradient(colors: [kAccent, kAccent2]),
                    ),
                    child: const Center(
                      child: Icon(LucideIcons.heart, fill: 1, size: 52, color: kAccentInk),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Text('Liked Songs',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      Text(
                          '${tracks.length} ${tracks.length == 1 ? 'song' : 'songs'}'
                          '${totalSec > 0 ? ' · ${formatPlaylistLength(totalSec)}' : ''}',
                          style: const TextStyle(color: kMuted, fontSize: 13)),
                    ]),
                  ),
                ]),
              ),
              if (selecting)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: SelectionBar(
                    count: _selected.length,
                    total: tracks.length,
                    onClear: () => setState(_selected.clear),
                    onSelectAll: () => setState(() {
                      if (_selected.length == tracks.length) {
                        _selected.clear();
                      } else {
                        _selected.addAll(tracks.map((t) => t.id));
                      }
                    }),
                    actions: [
                      SelectionAction(
                          LucideIcons.addToQueue, 'Add to queue', () => _bulkQueue(tracks)),
                      SelectionAction(
                          LucideIcons.listPlus, 'Add to playlist', () => _bulkAddTo(tracks)),
                      SelectionAction(LucideIcons.heart, 'Remove from Liked', () => _bulkUnlike(tracks),
                          danger: true),
                    ],
                  ),
                ),
              if (!selecting)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
                child: Row(children: [
                  PlayRoundButton(
                    onPressed: () => context.read<PlayerModel>().playQueue(
                          tracks,
                          shuffle: _shufflePref,
                          anchorStart: false, // shuffled → the first song is random too
                        ),
                  ),
                  const SizedBox(width: 12),
                  ShuffleToggleButton(on: _shufflePref, onPressed: _toggleShufflePref),
                  const SizedBox(width: 12),
                  AddToQueueButton(tracks: tracks, shuffle: _shufflePref),
                  const SizedBox(width: 12),
                  DownloadToggleButton(tracks: tracks, source: 'liked', name: 'Liked Songs'),
                ]),
              ),
              Expanded(
                child: ListView.builder(
                  itemCount: tracks.length,
                  itemBuilder: (context, i) => TrackTile(
                    tracks: tracks,
                    index: i,
                    selectedIds: _selected,
                    onSelectToggle: _toggleSelect,
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
