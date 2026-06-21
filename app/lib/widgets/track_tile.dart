import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../downloads.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';
import 'like_button.dart';

/// A single track row. Tapping plays [tracks] starting at [index].
class TrackTile extends StatelessWidget {
  final List<Track> tracks;
  final int index;
  final bool showCover;
  final bool showUploader;

  const TrackTile({
    super.key,
    required this.tracks,
    required this.index,
    this.showCover = true,
    this.showUploader = false,
  });

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final player = context.watch<PlayerModel>();
    final downloads = context.watch<DownloadManager>();
    final track = tracks[index];
    final isCurrent = player.current?.id == track.id;

    return ListTile(
      leading: showCover
          ? Cover(url: api.trackCoverUrl(track.id), size: 44)
          : SizedBox(
              width: 28,
              child: Center(
                child: isCurrent && player.playing
                    ? const Icon(LucideIcons.music2, size: 15, color: kAccent)
                    : Text("${index + 1}", style: const TextStyle(color: kMuted)),
              ),
            ),
      title: Text(
        track.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontWeight: FontWeight.w500, color: isCurrent ? kAccent : null),
      ),
      subtitle: Text(
        showUploader && (track.uploaderName?.isNotEmpty ?? false)
            ? '${track.artistName} · uploaded by ${track.uploaderName}'
            : track.artistName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          LikeButton(trackId: track.id, size: 18),
          if (downloads.isDownloading(track.id))
            const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
          else if (downloads.isDownloaded(track.id))
            const Icon(LucideIcons.checkCircle, size: 17, color: kAccent),
          _menu(context, track, downloads),
        ],
      ),
      onTap: () => player.playQueue(tracks, start: index),
    );
  }

  Widget _menu(BuildContext context, Track track, DownloadManager downloads) {
    return PopupMenuButton<String>(
      icon: const Icon(LucideIcons.moreVertical, size: 18, color: kMuted),
      color: kPanel2,
      onSelected: (value) async {
        switch (value) {
          case 'next':
            await context.read<PlayerModel>().playNext(track);
            break;
          case 'queue':
            await context.read<PlayerModel>().addToQueue(track);
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
      },
      itemBuilder: (_) => [
        const PopupMenuItem(
          value: 'next',
          child: Row(children: [
            Icon(LucideIcons.skipForward, size: 16),
            SizedBox(width: 10),
            Text("Play next"),
          ]),
        ),
        const PopupMenuItem(
          value: 'queue',
          child: Row(children: [
            Icon(LucideIcons.listMusic, size: 16),
            SizedBox(width: 10),
            Text("Add to queue"),
          ]),
        ),
        const PopupMenuItem(
          value: 'playlist',
          child: Row(children: [
            Icon(LucideIcons.listPlus, size: 16),
            SizedBox(width: 10),
            Text("Add to playlist"),
          ]),
        ),
        if (downloads.supported)
          downloads.isDownloaded(track.id)
              ? const PopupMenuItem(
                  value: 'undownload',
                  child: Row(children: [
                    Icon(LucideIcons.trash2, size: 16),
                    SizedBox(width: 10),
                    Text("Remove download"),
                  ]),
                )
              : const PopupMenuItem(
                  value: 'download',
                  child: Row(children: [
                    Icon(LucideIcons.downloadCloud, size: 16),
                    SizedBox(width: 10),
                    Text("Download"),
                  ]),
                ),
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
              child: Text("Add to playlist", style: TextStyle(fontWeight: FontWeight.bold)),
            ),
            if (playlists.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text("No playlists yet", style: TextStyle(color: kMuted)),
              ),
            ...playlists.map((pl) => ListTile(
                  leading: const Icon(LucideIcons.listMusic, size: 18),
                  title: Text(pl.name),
                  onTap: () async {
                    await api.addToPlaylist(pl.id, track.id);
                    if (ctx.mounted) Navigator.pop(ctx);
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text("Added to ${pl.name}"), duration: const Duration(seconds: 1)),
                      );
                    }
                  },
                )),
          ],
        ),
      ),
    );
  }
}
