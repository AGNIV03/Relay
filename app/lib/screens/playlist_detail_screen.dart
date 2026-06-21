import 'package:file_picker/file_picker.dart';
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
  int _coverVer = 0; // bumps to refresh the cover image after a change

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() => _future = context.read<Api>().playlist(widget.playlistId);

  void _editCover() {
    showModalBottomSheet(
      context: context,
      backgroundColor: kPanel,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(LucideIcons.refreshCw, size: 20),
            title: const Text('Regenerate collage'),
            onTap: () {
              Navigator.pop(ctx);
              _regenerateCover();
            },
          ),
          ListTile(
            leading: const Icon(LucideIcons.upload, size: 20),
            title: const Text('Upload image'),
            onTap: () {
              Navigator.pop(ctx);
              _uploadCover();
            },
          ),
        ]),
      ),
    );
  }

  Future<void> _regenerateCover() async {
    final api = context.read<Api>();
    final messenger = ScaffoldMessenger.of(context);
    try {
      await api.regeneratePlaylistCover(widget.playlistId);
      if (mounted) setState(() => _coverVer++);
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('No track covers to collage yet')));
    }
  }

  Future<void> _uploadCover() async {
    final api = context.read<Api>();
    final res = await FilePicker.platform.pickFiles(type: FileType.image);
    final path = res?.files.single.path;
    if (path == null) return;
    try {
      await api.uploadPlaylistCover(widget.playlistId, path);
      if (mounted) setState(() => _coverVer++);
    } catch (_) {}
  }

  Widget _coverHeader(int trackCount) {
    final api = context.read<Api>();
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(children: [
        GestureDetector(
          onTap: _editCover,
          child: Stack(children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Image.network(
                api.playlistCoverUrl(widget.playlistId, _coverVer),
                width: 120,
                height: 120,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => Container(
                  width: 120,
                  height: 120,
                  color: kPanel2,
                  child: const Icon(Icons.music_note, color: kMuted, size: 44),
                ),
              ),
            ),
            Positioned(
              right: 6,
              bottom: 6,
              child: Container(
                padding: const EdgeInsets.all(5),
                decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                child: const Icon(LucideIcons.upload, size: 14, color: Colors.white),
              ),
            ),
          ]),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(widget.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text('$trackCount ${trackCount == 1 ? 'song' : 'songs'}',
                style: const TextStyle(color: kMuted, fontSize: 13)),
            const SizedBox(height: 2),
            Text('Tap the cover to change it',
                style: TextStyle(color: kMuted.withValues(alpha: 0.7), fontSize: 11)),
          ]),
        ),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.name)),
      body: FutureBuilder<Playlist>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tracks = snap.data!.tracks;
          final downloads = context.watch<DownloadManager>();
          final allDown = downloads.allDownloaded(tracks);
          final downCount = downloads.downloadedCount(tracks);
          return Column(
            children: [
              _coverHeader(tracks.length),
              if (tracks.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
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
                child: tracks.isEmpty
                    ? const Center(
                        child: Text('Empty playlist.\nAdd tracks with the ⋮ menu.',
                            textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
                      )
                    : ListView.builder(
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
