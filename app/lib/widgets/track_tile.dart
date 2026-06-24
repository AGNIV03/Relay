import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_state.dart';
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
  final bool showDownload; // show an inline download/remove toggle button
  final VoidCallback? onChanged; // called after a destructive change (e.g. delete)
  // Multi-select: when [onSelectToggle] is given, long-press selects; while any
  // row is selected a tap toggles selection instead of starting playback.
  final Set<String> selectedIds;
  final void Function(Track)? onSelectToggle;

  const TrackTile({
    super.key,
    required this.tracks,
    required this.index,
    this.showCover = true,
    this.showUploader = false,
    this.showDownload = false,
    this.onChanged,
    this.selectedIds = const {},
    this.onSelectToggle,
  });

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final player = context.watch<PlayerModel>();
    final downloads = context.watch<DownloadManager>();
    final track = tracks[index];
    final isCurrent = player.current?.id == track.id;
    final selectable = onSelectToggle != null;
    final selectionMode = selectable && selectedIds.isNotEmpty;
    final isSelected = selectedIds.contains(track.id);

    return ListTile(
      selected: isSelected,
      selectedTileColor: kPanel2,
      leading: selectionMode
          ? SizedBox(
              width: 44,
              child: Center(
                child: Icon(
                  isSelected ? LucideIcons.checkCircle : LucideIcons.circle,
                  color: isSelected ? kAccent : kMuted,
                ),
              ),
            )
          : showCover
              ? Cover(url: api.trackCoverUrl(track.id), trackId: track.id, size: 44)
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
      trailing: selectionMode
          ? null
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                LikeButton(trackId: track.id, size: 18),
                if (showDownload && downloads.supported)
                  _downloadButton(context, track, downloads)
                else if (downloads.isDownloading(track.id))
                  const SizedBox(
                      width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                else if (downloads.isDownloaded(track.id))
                  const Icon(LucideIcons.checkCircle, size: 17, color: kAccent),
                TrackMenu(track: track, onChanged: onChanged),
              ],
            ),
      onTap: selectionMode
          ? () => onSelectToggle!(track)
          : () => player.playQueue(tracks, start: index),
      onLongPress: selectable ? () => onSelectToggle!(track) : null,
    );
  }

  /// Inline download/remove toggle for a single track.
  Widget _downloadButton(BuildContext context, Track track, DownloadManager downloads) {
    if (downloads.isDownloading(track.id)) {
      return const SizedBox(
        width: 40,
        height: 40,
        child: Padding(padding: EdgeInsets.all(11), child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    final done = downloads.isDownloaded(track.id);
    return IconButton(
      iconSize: 18,
      tooltip: done ? 'Remove download' : 'Download',
      icon: Icon(done ? LucideIcons.checkCircle : LucideIcons.download,
          color: done ? kAccent : kMuted),
      onPressed: () async {
        if (done) return downloads.remove(track.id);
        try {
          await downloads.download(track);
        } catch (e) {
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
          }
        }
      },
    );
  }
}

/// The per-track "⋮" popup menu (Play next / Add to queue / playlist / download).
/// Shared by the mobile list tile and the desktop table.
class TrackMenu extends StatelessWidget {
  final Track track;
  final VoidCallback? onChanged;
  const TrackMenu({super.key, required this.track, this.onChanged});

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadManager>();
    final user = context.watch<AppState>().user;
    final canDelete =
        (user?.isAdmin ?? false) || (track.uploaderName != null && track.uploaderName == user?.username);
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
            try {
              await downloads.download(track);
            } catch (e) {
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
              }
            }
            break;
          case 'undownload':
            await downloads.remove(track.id);
            break;
          case 'playlist':
            if (context.mounted) await _addToPlaylist(context, track);
            break;
          case 'delete':
            if (context.mounted) await _delete(context);
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
        if (canDelete) ...[
          const PopupMenuDivider(),
          const PopupMenuItem(
            value: 'delete',
            child: Row(children: [
              Icon(LucideIcons.trash2, size: 16, color: Color(0xFFEF4444)),
              SizedBox(width: 10),
              Text("Delete song", style: TextStyle(color: Color(0xFFEF4444))),
            ]),
          ),
        ],
      ],
    );
  }

  /// Confirm + permanently delete the track (file + DB), then notify the parent.
  Future<void> _delete(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kPanel,
        title: const Text('Delete song?'),
        content: Text(
          '"${track.title}" will be permanently removed from the server, '
          'including the file. This cannot be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete', style: TextStyle(color: Color(0xFFEF4444))),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      await context.read<Api>().deleteTrack(track.id);
      onChanged?.call();
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Deleted "${track.title}"'), duration: const Duration(seconds: 2)),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Delete failed: $e')));
      }
    }
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
                    String msg;
                    try {
                      await api.addToPlaylist(pl.id, track.id);
                      msg = "Added to ${pl.name}";
                    } on ApiException catch (e) {
                      // Backend returns 409 "Track already in playlist".
                      msg = e.message.toLowerCase().contains("already")
                          ? "Song already in playlist"
                          : e.message;
                    } catch (_) {
                      msg = "Couldn't add to playlist";
                    }
                    if (ctx.mounted) Navigator.pop(ctx); // always close the menu
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(msg), duration: const Duration(seconds: 1)),
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
