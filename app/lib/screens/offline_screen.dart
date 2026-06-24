import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../downloads.dart';
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

/// Offline home: a banner, downloaded songs, and downloaded playlists. Only
/// locally-stored audio can be played here.
class OfflineRoot extends StatelessWidget {
  const OfflineRoot({super.key});

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadManager>();
    final tracks = downloads.offlineTracks;
    final playlists = downloads.offlinePlaylists;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Offline mode'),
        actions: [
          IconButton(
            tooltip: 'Retry connection',
            icon: const Icon(LucideIcons.refreshCw),
            onPressed: () => _retry(context),
          ),
        ],
      ),
      // SafeArea keeps the player controls above the system navigation bar
      // (offline mode has no bottom nav bar to provide that inset).
      bottomNavigationBar: const SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, children: [MiniPlayer()]),
      ),
      body: ListView(
        children: [
          Container(
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
          ),
          if (playlists.isNotEmpty) ...[
            _header('Downloaded playlists'),
            ...playlists.map((pl) => ListTile(
                  leading: Cover(trackId: pl.tracks.first.id, size: 44),
                  title: Text(pl.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text('${pl.tracks.length} songs',
                      style: const TextStyle(color: kMuted, fontSize: 12)),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => OfflinePlaylistScreen(playlist: pl)),
                  ),
                )),
          ],
          _header('Downloaded songs'),
          if (tracks.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No downloaded songs', style: TextStyle(color: kMuted)),
            )
          else
            ...List.generate(
              tracks.length,
              (i) => TrackTile(tracks: tracks, index: i),
            ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }

  Widget _header(String t) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
        child: Text(t, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
      );
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
              itemBuilder: (_, i) => TrackTile(tracks: tracks, index: i),
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
