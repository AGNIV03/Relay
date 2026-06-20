import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../downloads.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';

/// A single track row. Tapping plays [tracks] starting at [index].
class TrackTile extends StatelessWidget {
  final List<Track> tracks;
  final int index;
  final bool showCover;
  final VoidCallback? onChanged;

  const TrackTile({
    super.key,
    required this.tracks,
    required this.index,
    this.showCover = true,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final player = context.watch<PlayerModel>();
    final downloads = context.watch<DownloadManager>();
    final track = tracks[index];
    final isCurrent = player.current?.id == track.id;

    return ListTile(
      leading: showCover ? Cover(url: api.trackCoverUrl(track.id), size: 44) : Text('${index + 1}'),
      title: Text(
        track.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontWeight: FontWeight.w500,
          color: isCurrent ? kAccent2 : null,
        ),
      ),
      subtitle: Text(
        track.artistName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (downloads.isDownloading(track.id))
            const SizedBox(
                width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
          else if (downloads.isDownloaded(track.id))
            const Icon(Icons.download_done, size: 18, color: kAccent2),
          _menu(context, track, downloads),
        ],
      ),
      onTap: () => player.playQueue(tracks, start: index),
    );
  }

  Widget _menu(BuildContext context, Track track, DownloadManager downloads) {
    final api = context.read<Api>();
    return PopupMenuButton<String>(
      icon: const Icon(Icons.more_vert, size: 20),
      onSelected: (value) async {
        switch (value) {
          case 'fav':
            await api.addFavorite(track.id);
            if (context.mounted) _toast(context, 'Added to favorites');
            break;
          case 'unfav':
            await api.removeFavorite(track.id);
            if (context.mounted) _toast(context, 'Removed from favorites');
            break;
          case 'download':
            await downloads.download(track);
            break;
          case 'undownload':
            await downloads.remove(track.id);
            break;
          case 'playlist':
            if (context.mounted) await _addToPlaylist(context, track);
            break;
        }
        onChanged?.call();
      },
      itemBuilder: (_) => [
        const PopupMenuItem(value: 'fav', child: Text('♥ Favorite')),
        const PopupMenuItem(value: 'unfav', child: Text('Remove favorite')),
        const PopupMenuItem(value: 'playlist', child: Text('Add to playlist…')),
        if (downloads.supported)
          downloads.isDownloaded(track.id)
              ? const PopupMenuItem(value: 'undownload', child: Text('Remove download'))
              : const PopupMenuItem(value: 'download', child: Text('Download')),
      ],
    );
  }

  Future<void> _addToPlaylist(BuildContext context, Track track) async {
    final api = context.read<Api>();
    final playlists = await api.playlists();
    if (!context.mounted) return;
    await showModalBottomSheet(
      context: context,
      backgroundColor: kPanel,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Add to playlist', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
            if (playlists.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('No playlists yet', style: TextStyle(color: kMuted)),
              ),
            ...playlists.map((pl) => ListTile(
                  title: Text(pl.name),
                  onTap: () async {
                    await api.addToPlaylist(pl.id, track.id);
                    if (ctx.mounted) Navigator.pop(ctx);
                    if (context.mounted) _toast(context, 'Added to ${pl.name}');
                  },
                )),
          ],
        ),
      ),
    );
  }

  void _toast(BuildContext context, String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 1)),
    );
  }
}
