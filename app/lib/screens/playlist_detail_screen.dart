import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../downloads.dart';
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
          final downloads = context.watch<DownloadManager>();
          final allDown = downloads.allDownloaded(tracks);
          final downCount = downloads.downloadedCount(tracks);
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(8),
                child: Row(
                  children: [
                    FilledButton.icon(
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('Play'),
                      onPressed: () => context.read<PlayerModel>().playQueue(tracks),
                    ),
                    const SizedBox(width: 10),
                    if (downloads.supported)
                      OutlinedButton.icon(
                        icon: Icon(
                          allDown ? LucideIcons.checkCircle : LucideIcons.download,
                          size: 18,
                          color: allDown ? kAccent : null,
                        ),
                        label: Text(allDown
                            ? 'Downloaded'
                            : downCount > 0
                                ? 'Download ($downCount/${tracks.length})'
                                : 'Download'),
                        onPressed: () async {
                          if (allDown) {
                            await downloads.removeAll(tracks, widget.playlistId);
                          } else {
                            await downloads.downloadAll(tracks, widget.playlistId);
                          }
                        },
                      ),
                  ],
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
                      final id = tracks[i].id;
                      final api = context.read<Api>();
                      final downloads = context.read<DownloadManager>();
                      await api.removeFromPlaylist(widget.playlistId, id);
                      // Removed from this playlist — drop its download if no other
                      // source still needs it.
                      await downloads.onRemovedFromSource(id, widget.playlistId);
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
