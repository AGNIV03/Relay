import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/track_tile.dart';

class AlbumDetailScreen extends StatefulWidget {
  final String albumId;
  const AlbumDetailScreen({super.key, required this.albumId});
  @override
  State<AlbumDetailScreen> createState() => _AlbumDetailScreenState();
}

class _AlbumDetailScreenState extends State<AlbumDetailScreen> {
  late Future<Album> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<Api>().album(widget.albumId);
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Scaffold(
      appBar: AppBar(),
      body: FutureBuilder<Album>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final album = snap.data!;
          final tracks = album.tracks;
          return ListView(
            children: [
              Padding(
                padding: const EdgeInsets.all(20),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Cover(url: api.albumCoverUrl(album.id), size: 130, radius: 12),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(album.title,
                              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                          const SizedBox(height: 4),
                          Text(
                            '${album.artist?.name ?? ''}'
                            '${album.year != null ? ' · ${album.year}' : ''} · ${tracks.length} tracks',
                            style: const TextStyle(color: kMuted),
                          ),
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 10,
                            runSpacing: 8,
                            children: [
                              FilledButton.icon(
                                icon: const Icon(Icons.play_arrow),
                                label: const Text('Play'),
                                onPressed: tracks.isEmpty
                                    ? null
                                    : () => context.read<PlayerModel>().playQueue(tracks),
                              ),
                              OutlinedButton.icon(
                                icon: const Icon(Icons.shuffle, size: 18),
                                label: const Text('Shuffle'),
                                onPressed: tracks.isEmpty
                                    ? null
                                    : () => context.read<PlayerModel>().shuffleAndPlay(tracks),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              for (int i = 0; i < tracks.length; i++)
                TrackTile(tracks: tracks, index: i, showCover: false),
              const SizedBox(height: 12),
            ],
          );
        },
      ),
    );
  }
}
