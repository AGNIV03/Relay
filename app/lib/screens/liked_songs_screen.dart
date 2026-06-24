import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../downloads.dart';
import '../format.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/track_tile.dart';

/// The permanent "Liked Songs" playlist (backed by the likes table).
class LikedSongsScreen extends StatefulWidget {
  const LikedSongsScreen({super.key});
  @override
  State<LikedSongsScreen> createState() => _LikedSongsScreenState();
}

class _LikedSongsScreenState extends State<LikedSongsScreen> {
  Future<Playlist> _load() => context.read<Api>().liked();
  late final Future<Playlist> _future = _load();

  @override
  Widget build(BuildContext context) {
    // Re-fetch whenever the set of liked tracks changes.
    context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(title: const Text('Liked Songs')),
      body: FutureBuilder<Playlist>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tracks = snap.data!.tracks;
          if (tracks.isEmpty) {
            return const Center(
              child: Text('Songs you like will show up here.\nTap the ♥ on any track.',
                  textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
            );
          }
          final downloads = context.watch<DownloadManager>();
          final allDown = downloads.allDownloaded(tracks);
          final totalSec = totalDurationSeconds(tracks.map((t) => t.duration));
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
              Padding(
                padding: const EdgeInsets.all(8),
                child: Row(children: [
                  FilledButton.icon(
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Play'),
                    onPressed: () => context.read<PlayerModel>().playQueue(tracks),
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
                  if (downloads.supported)
                    OutlinedButton.icon(
                      icon: Icon(allDown ? LucideIcons.checkCircle : LucideIcons.download,
                          size: 18, color: allDown ? kAccent : null),
                      label: Text(allDown ? 'Downloaded' : 'Download'),
                      onPressed: () async {
                        if (allDown) {
                          await downloads.removeAll(tracks, 'liked');
                        } else {
                          try {
                            await downloads.downloadAll(tracks, 'liked', name: 'Liked Songs');
                          } catch (e) {
                            if (context.mounted) {
                              ScaffoldMessenger.of(context)
                                  .showSnackBar(SnackBar(content: Text('$e')));
                            }
                          }
                        }
                      },
                    ),
                ]),
              ),
              Expanded(
                child: ListView.builder(
                  itemCount: tracks.length,
                  itemBuilder: (context, i) => TrackTile(tracks: tracks, index: i),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
