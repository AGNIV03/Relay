import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
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
  late String _name;
  Playlist? _pl;
  int _coverVer = 0; // bumps to refresh the cover image after a change

  @override
  void initState() {
    super.initState();
    _name = widget.name;
    _load();
  }

  void _load() {
    final f = context.read<Api>().playlist(widget.playlistId);
    _future = f;
    f.then((p) {
      if (mounted) setState(() => _pl = p);
    }).catchError((_) {});
  }

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
            Text(_name,
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

  // ---- Playlist menu (rename / collaborators / delete) --------------------
  Future<void> _rename() async {
    final controller = TextEditingController(text: _name);
    final api = context.read<Api>();
    final newName = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kPanel,
        title: const Text('Rename playlist'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Playlist name'),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, controller.text.trim()),
              child: const Text('Save')),
        ],
      ),
    );
    if (newName == null || newName.isEmpty || newName == _name) return;
    try {
      await api.renamePlaylist(widget.playlistId, newName);
      if (mounted) setState(() => _name = newName);
    } catch (_) {}
  }

  Future<void> _confirmDelete() async {
    final api = context.read<Api>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kPanel,
        title: const Text('Delete playlist?'),
        content: Text('"$_name" will be permanently deleted. Songs stay in the library.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete', style: TextStyle(color: Color(0xFFEF4444)))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await api.deletePlaylist(widget.playlistId);
      if (mounted) Navigator.of(context).pop();
    } catch (_) {}
  }

  Future<void> _leave() async {
    final api = context.read<Api>();
    final myId = context.read<AppState>().user?.id;
    if (myId == null) return;
    try {
      await api.removeCollaborator(widget.playlistId, myId);
      if (mounted) Navigator.of(context).pop();
    } catch (_) {}
  }

  Future<void> _manageCollaborators() async {
    final api = context.read<Api>();
    List<Friend> users = [];
    Set<String> collabIds = {};
    try {
      users = await api.friends();
      final info = await api.playlistCollaborators(widget.playlistId);
      collabIds = info.collaborators.map((c) => c.id).toSet();
    } catch (_) {}
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          backgroundColor: kPanel,
          title: const Text('Collaborators'),
          content: SizedBox(
            width: 360,
            child: users.isEmpty
                ? const Text('No other users to add.', style: TextStyle(color: kMuted))
                : ListView(
                    shrinkWrap: true,
                    children: users.map((u) {
                      final isCollab = collabIds.contains(u.id);
                      return ListTile(
                        dense: true,
                        leading: CircleAvatar(
                          radius: 16,
                          backgroundColor: kPanel2,
                          child: Text(u.username.isNotEmpty ? u.username[0].toUpperCase() : '?'),
                        ),
                        title: Text(u.username, maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: TextButton.icon(
                          icon: Icon(isCollab ? LucideIcons.check : LucideIcons.plus, size: 16),
                          label: Text(isCollab ? 'Added' : 'Add'),
                          style: TextButton.styleFrom(
                              foregroundColor: isCollab ? kAccent : kMuted),
                          onPressed: () async {
                            try {
                              if (isCollab) {
                                await api.removeCollaborator(widget.playlistId, u.id);
                                collabIds.remove(u.id);
                              } else {
                                await api.addCollaborator(widget.playlistId, u.id);
                                collabIds.add(u.id);
                              }
                              setLocal(() {});
                            } catch (_) {}
                          },
                        ),
                      );
                    }).toList(),
                  ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done')),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final owned = _pl?.owned ?? true;
    return Scaffold(
      appBar: AppBar(
        title: Text(_name),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(LucideIcons.moreVertical),
            color: kPanel2,
            onSelected: (v) {
              switch (v) {
                case 'rename':
                  _rename();
                  break;
                case 'collab':
                  _manageCollaborators();
                  break;
                case 'delete':
                  _confirmDelete();
                  break;
                case 'leave':
                  _leave();
                  break;
              }
            },
            itemBuilder: (_) => owned
                ? const [
                    PopupMenuItem(
                        value: 'rename',
                        child: Row(children: [
                          Icon(LucideIcons.settings, size: 16),
                          SizedBox(width: 10),
                          Text('Rename')
                        ])),
                    PopupMenuItem(
                        value: 'collab',
                        child: Row(children: [
                          Icon(LucideIcons.users, size: 16),
                          SizedBox(width: 10),
                          Text('Manage collaborators')
                        ])),
                    PopupMenuItem(
                        value: 'delete',
                        child: Row(children: [
                          Icon(LucideIcons.trash2, size: 16, color: Color(0xFFEF4444)),
                          SizedBox(width: 10),
                          Text('Delete', style: TextStyle(color: Color(0xFFEF4444)))
                        ])),
                  ]
                : const [
                    PopupMenuItem(
                        value: 'leave',
                        child: Row(children: [
                          Icon(LucideIcons.logOut, size: 16, color: Color(0xFFEF4444)),
                          SizedBox(width: 10),
                          Text('Leave playlist', style: TextStyle(color: Color(0xFFEF4444)))
                        ])),
                  ],
          ),
        ],
      ),
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
                              await downloads.downloadAll(tracks, widget.playlistId, name: _name);
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
                    child: TrackTile(tracks: tracks, index: i, showDownload: true),
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
