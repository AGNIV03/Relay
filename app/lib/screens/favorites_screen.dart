import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/track_tile.dart';

class FavoritesScreen extends StatefulWidget {
  const FavoritesScreen({super.key});
  @override
  State<FavoritesScreen> createState() => _FavoritesScreenState();
}

class _FavoritesScreenState extends State<FavoritesScreen> {
  late Future<List<Track>> _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() => _future = context.read<Api>().favorites();

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async => setState(_load),
      child: FutureBuilder<List<Track>>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tracks = snap.data!;
          if (tracks.isEmpty) {
            return ListView(children: const [
              Padding(
                padding: EdgeInsets.all(32),
                child: Text('No favorites yet.\nTap ⋮ on a track to add one.',
                    textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
              ),
            ]);
          }
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(8),
                child: FilledButton.icon(
                  icon: const Icon(Icons.play_arrow),
                  label: const Text('Play all'),
                  onPressed: () => context.read<PlayerModel>().playQueue(tracks),
                ),
              ),
              Expanded(
                child: ListView.builder(
                  itemCount: tracks.length,
                  itemBuilder: (context, i) =>
                      TrackTile(tracks: tracks, index: i, onChanged: () => setState(_load)),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
