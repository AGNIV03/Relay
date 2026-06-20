import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/track_tile.dart';

class PlaylistDetailScreen extends StatefulWidget {
  final String playlistId;
  final String name;
  const PlaylistDetailScreen({super.key, required this.playlistId, required this.name});
  @override
  State<PlaylistDetailScreen> createState() => _PlaylistDetailScreenState();
}

class _PlaylistDetailScreenState extends State<PlaylistDetailScreen> {
  late Future<Playlist> _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() => _future = context.read<Api>().playlist(widget.playlistId);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.name)),
      body: FutureBuilder<Playlist>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tracks = snap.data!.tracks;
          if (tracks.isEmpty) {
            return const Center(
              child: Text('Empty playlist.\nAdd tracks with the ⋮ menu.',
                  textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
            );
          }
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(8),
                child: FilledButton.icon(
                  icon: const Icon(Icons.play_arrow),
                  label: const Text('Play'),
                  onPressed: () => context.read<PlayerModel>().playQueue(tracks),
                ),
              ),
              Expanded(
                child: ListView.builder(
                  itemCount: tracks.length,
                  itemBuilder: (context, i) => Dismissible(
                    key: ValueKey(tracks[i].id),
                    direction: DismissDirection.endToStart,
                    background: Container(
                      color: Colors.red.withValues(alpha: 0.3),
                      alignment: Alignment.centerRight,
                      padding: const EdgeInsets.only(right: 20),
                      child: const Icon(Icons.delete),
                    ),
                    onDismissed: (_) async {
                      await context
                          .read<Api>()
                          .removeFromPlaylist(widget.playlistId, tracks[i].id);
                    },
                    child: TrackTile(tracks: tracks, index: i),
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
