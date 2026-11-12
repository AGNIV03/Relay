import 'dart:io' show Platform;
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api.dart';
import '../format.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../downloads.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/playlist_actions.dart';
import '../widgets/track_selection.dart';
import '../widgets/track_sort.dart';
import '../widgets/track_table.dart';
import '../widgets/track_tile.dart';

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

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
  bool? _publicOverride; // reflects a public/private toggle before a reload

  bool get _isPublicNow => _publicOverride ?? _pl?.isPublic ?? false;
  int _coverVer = 0; // bumps to refresh the cover image after a change

  // Per-playlist shuffle preference (remembered): when on, pressing Play plays a
  // shuffled order. This is separate from the global playback-controls shuffle and
  // never reorders anything currently playing.
  bool _shufflePref = false;
  String get _shuffleKey => 'pl_shuffle_${widget.playlistId}';

  // Remembered track ordering for this playlist (playlist order by default).
  final _sort = TrackSortState();

  // Multi-select (long-press on mobile, long-press/right-click on desktop).
  final Set<String> _selected = {};
  // Mobile reorder mode (drag handles); desktop drags rows in the table.
  bool _reorderMode = false;
  // Optimistic track order after a drag, until the next reload confirms it.
  List<Track>? _orderOverride;

  bool get _canEdit {
    final myId = context.read<AppState>().user?.id;
    return (_pl?.owned ?? false) || (_pl?.collaborators.any((c) => c.id == myId) ?? false);
  }

  /// Reordering saves the playlist's own order, so it's only offered while the
  /// list is shown in that order (Playlist order, ascending).
  bool get _inPlaylistOrder => _sort.order == TrackOrder.custom && _sort.asc;

  @override
  void initState() {
    super.initState();
    _name = widget.name;
    _load();
    SharedPreferences.getInstance().then((p) {
      if (mounted) setState(() => _shufflePref = p.getBool(_shuffleKey) ?? false);
    });
    _sort.load(widget.playlistId).then((_) {
      if (mounted) setState(() {});
    });
  }

  Future<void> _toggleShufflePref() async {
    setState(() => _shufflePref = !_shufflePref);
    final p = await SharedPreferences.getInstance();
    await p.setBool(_shuffleKey, _shufflePref);
  }

  void _load() {
    final f = context.read<Api>().playlist(widget.playlistId);
    _future = f;
    f.then((p) {
      if (mounted) {
        setState(() {
          _pl = p;
          _orderOverride = null;
          _selected.retainWhere((id) => p.tracks.any((t) => t.id == id));
        });
      }
    }).catchError((_) {});
  }

  // ---- Reorder ----
  /// Move a track from [from] to [to] (indexes into the playlist order) and save
  /// the full new order. Optimistic: reverts and reloads if the save fails.
  Future<void> _move(List<Track> current, int from, int to) async {
    final list = List<Track>.of(current);
    list.insert(to, list.removeAt(from));
    setState(() => _orderOverride = list);
    try {
      await context.read<Api>().reorderPlaylist(widget.playlistId, [for (final t in list) t.id]);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("Couldn't save the new order: $e")));
      setState(() {
        _orderOverride = null;
        _load();
      });
    }
  }

  void _toggleReorderMode() {
    if (!_reorderMode && !_inPlaylistOrder) {
      // Reordering edits the playlist's own order: switch the view to it first.
      setState(() {
        _sort.order = TrackOrder.custom;
        _sort.asc = true;
      });
      _sort.save(widget.playlistId);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Showing Playlist order so you can rearrange it'),
          duration: Duration(seconds: 2)));
    }
    setState(() {
      _reorderMode = !_reorderMode;
      _selected.clear();
    });
  }

  // ---- Multi-select ----
  void _toggleSelect(Track t) => setState(() {
        if (!_selected.remove(t.id)) _selected.add(t.id);
      });

  List<Track> _selectedTracks(List<Track> shown) =>
      shown.where((t) => _selected.contains(t.id)).toList();

  String _songs(int n) => '$n ${n == 1 ? 'song' : 'songs'}';

  Future<void> _bulkQueue(List<Track> shown) async {
    final picked = _selectedTracks(shown);
    if (picked.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    await context.read<PlayerModel>().addAllToQueue(picked);
    messenger.showSnackBar(SnackBar(
        content: Text('Added ${_songs(picked.length)} to the queue'),
        duration: const Duration(seconds: 2)));
    if (mounted) setState(_selected.clear);
  }

  Future<void> _bulkAddTo(List<Track> shown) async {
    final picked = _selectedTracks(shown);
    if (picked.isEmpty) return;
    final api = context.read<Api>();
    final messenger = ScaffoldMessenger.of(context);
    final target = await pickPlaylist(context,
        title: 'Add ${_songs(picked.length)} to playlist', excludeId: widget.playlistId);
    if (target == null) return;
    try {
      final added = await api.addManyToPlaylist(target.id, [for (final t in picked) t.id]);
      final skipped = picked.length - added;
      messenger.showSnackBar(SnackBar(
          content: Text('Added $added to ${target.name}'
              '${skipped > 0 ? ' ($skipped already there)' : ''}')));
      if (mounted) setState(_selected.clear);
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't add to playlist")));
    }
  }

  Future<void> _bulkMove(List<Track> shown) async {
    final picked = _selectedTracks(shown);
    if (picked.isEmpty) return;
    final api = context.read<Api>();
    final downloads = context.read<DownloadManager>();
    final messenger = ScaffoldMessenger.of(context);
    final target = await pickPlaylist(context,
        title: 'Move ${_songs(picked.length)} to playlist', excludeId: widget.playlistId);
    if (target == null) return;
    final ids = [for (final t in picked) t.id];
    try {
      await api.addManyToPlaylist(target.id, ids);
      await api.removeManyFromPlaylist(widget.playlistId, ids);
      for (final id in ids) {
        await downloads.onRemovedFromSource(id, widget.playlistId);
      }
      messenger.showSnackBar(SnackBar(content: Text('Moved ${_songs(ids.length)} to ${target.name}')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't move: $e")));
    }
    if (mounted) {
      setState(() {
        _selected.clear();
        _load();
      });
    }
  }

  Future<void> _bulkRemove(List<Track> shown) async {
    final picked = _selectedTracks(shown);
    if (picked.isEmpty) return;
    final api = context.read<Api>();
    final downloads = context.read<DownloadManager>();
    final messenger = ScaffoldMessenger.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kPanel,
        title: Text('Remove ${_songs(picked.length)}?'),
        content: Text('They will be removed from "$_name". The songs stay in the library.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Remove', style: TextStyle(color: Color(0xFFEF4444)))),
        ],
      ),
    );
    if (ok != true) return;
    final ids = [for (final t in picked) t.id];
    try {
      final removed = await api.removeManyFromPlaylist(widget.playlistId, ids);
      for (final id in ids) {
        await downloads.onRemovedFromSource(id, widget.playlistId);
      }
      messenger.showSnackBar(SnackBar(content: Text('Removed ${_songs(removed)}')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't remove: $e")));
    }
    if (mounted) {
      setState(() {
        _selected.clear();
        _load();
      });
    }
  }

  Widget _selectionBar(List<Track> shown) => SelectionBar(
        count: _selected.length,
        total: shown.length,
        onClear: () => setState(_selected.clear),
        onSelectAll: () => setState(() {
          if (_selected.length == shown.length) {
            _selected.clear();
          } else {
            _selected.addAll(shown.map((t) => t.id));
          }
        }),
        actions: [
          SelectionAction(LucideIcons.addToQueue, 'Add to queue', () => _bulkQueue(shown)),
          SelectionAction(LucideIcons.listPlus, 'Add to playlist', () => _bulkAddTo(shown)),
          if (_canEdit) ...[
            SelectionAction(Icons.drive_file_move_outline, 'Move to playlist…',
                () => _bulkMove(shown)),
            SelectionAction(LucideIcons.trash2, 'Remove', () => _bulkRemove(shown), danger: true),
          ],
        ],
      );

  /// Mobile reorder mode: plain rows with a drag handle (drag the handle, or
  /// long-press anywhere on the row).
  Widget _reorderList(List<Track> tracks) {
    final api = context.read<Api>();
    return ReorderableListView.builder(
      buildDefaultDragHandles: false,
      itemCount: tracks.length,
      onReorderItem: (from, to) {
        if (to != from) _move(tracks, from, to);
      },
      itemBuilder: (context, i) {
        final t = tracks[i];
        return ReorderableDelayedDragStartListener(
          key: ValueKey(t.id),
          index: i,
          child: Material(
            color: Colors.transparent,
            child: ListTile(
              leading: Cover(url: api.trackCoverUrl(t.id), trackId: t.id, size: 44),
              title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(t.artistName, maxLines: 1, overflow: TextOverflow.ellipsis),
              trailing: ReorderableDragStartListener(
                index: i,
                child: const Padding(
                  padding: EdgeInsets.all(8),
                  child: Icon(Icons.drag_handle, color: kMuted),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _removeFromPlaylist(String id) async {
    final api = context.read<Api>();
    final downloads = context.read<DownloadManager>();
    await api.removeFromPlaylist(widget.playlistId, id).catchError((_) {});
    // Dropped from this playlist — release its download if nothing else needs it.
    await downloads.onRemovedFromSource(id, widget.playlistId);
    if (mounted) setState(_load);
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
    final messenger = ScaffoldMessenger.of(context);
    // withData so we reliably get bytes on Android (a picked image's path is
    // often a content URI that MultipartFile.fromPath cannot read).
    final res = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    final file = res?.files.singleOrNull;
    if (file == null) return;
    try {
      if (file.bytes != null) {
        await api.uploadPlaylistCoverBytes(widget.playlistId, file.bytes!, file.name);
      } else if (file.path != null) {
        await api.uploadPlaylistCover(widget.playlistId, file.path!);
      } else {
        throw 'No image data';
      }
      // Evict the currently-shown cover from the image cache and bump the version
      // so the new image is fetched and displayed immediately.
      await NetworkImage(api.playlistCoverUrl(widget.playlistId, _coverVer)).evict();
      if (mounted) setState(() => _coverVer++);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Cover upload failed: $e')));
    }
  }

  Widget _coverHeader(int trackCount, int totalSec) {
    final api = context.read<Api>();
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(children: [
        GestureDetector(
          onTap: (_pl?.owned ?? true) ? _editCover : null, // only the owner edits the cover
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
            Text(
                '$trackCount ${trackCount == 1 ? 'song' : 'songs'}'
                '${totalSec > 0 ? ' · ${formatPlaylistLength(totalSec)}' : ''}',
                style: const TextStyle(color: kMuted, fontSize: 13)),
            if (_pl?.owned ?? true) ...[
              const SizedBox(height: 2),
              Text('Tap the cover to change it',
                  style: TextStyle(color: kMuted.withValues(alpha: 0.7), fontSize: 11)),
            ],
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

  Future<void> _togglePublic() async {
    final next = !_isPublicNow;
    try {
      await context.read<Api>().setPlaylistPublic(widget.playlistId, next);
      if (mounted) {
        setState(() => _publicOverride = next);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(next
              ? 'Playlist is now public — it shows in everyone\'s Curated playlists'
              : 'Playlist is now private'),
          duration: const Duration(seconds: 2),
        ));
      }
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
    String query = '';
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
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        autofocus: true,
                        decoration: const InputDecoration(
                            hintText: 'Search people…', isDense: true),
                        onChanged: (v) => setLocal(() => query = v),
                      ),
                      const SizedBox(height: 8),
                      Flexible(
                        child: ListView(
                          shrinkWrap: true,
                          children: users
                              .where((u) => u.username
                                  .toLowerCase()
                                  .contains(query.trim().toLowerCase()))
                              .map((u) {
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
                    ],
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
    final myId = context.read<AppState>().user?.id;
    final isCollaborator = _pl?.collaborators.any((c) => c.id == myId) ?? false;
    // A pure viewer (someone else's playlist, not a collaborator) gets no menu.
    final showMenu = owned || isCollaborator;
    return Scaffold(
      appBar: AppBar(
        title: Text(_name),
        actions: [
          if (!_isDesktop && showMenu && (_pl?.tracks.length ?? 0) > 1)
            IconButton(
              tooltip: _reorderMode ? 'Done rearranging' : 'Rearrange',
              icon: Icon(_reorderMode ? LucideIcons.check : Icons.low_priority,
                  color: _reorderMode ? kAccent : null),
              onPressed: _toggleReorderMode,
            ),
          if (!_reorderMode)
          TrackSortButton(
            state: _sort,
            onSelected: (o) {
              setState(() => _sort.pick(o));
              _sort.save(widget.playlistId);
            },
          ),
          if (showMenu)
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
                case 'public':
                  _togglePublic();
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
                ? [
                    const PopupMenuItem(
                        value: 'rename',
                        child: Row(children: [
                          Icon(LucideIcons.settings, size: 16),
                          SizedBox(width: 10),
                          Text('Rename')
                        ])),
                    const PopupMenuItem(
                        value: 'collab',
                        child: Row(children: [
                          Icon(LucideIcons.users, size: 16),
                          SizedBox(width: 10),
                          Text('Manage collaborators')
                        ])),
                    PopupMenuItem(
                        value: 'public',
                        child: Row(children: [
                          Icon(_isPublicNow ? Icons.lock_outline : Icons.public,
                              size: 16, color: kAccent),
                          const SizedBox(width: 10),
                          Text(_isPublicNow ? 'Make private' : 'Make public'),
                        ])),
                    const PopupMenuItem(
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
          // Shown, played and queued in the chosen order.
          final base = _orderOverride ?? snap.data!.tracks;
          final tracks = sortTracks(base, _sort.order, _sort.asc, addedAt: _pl?.addedAt);
          final canReorder = showMenu && _inPlaylistOrder;
          final selecting = _selected.isNotEmpty;
          final totalSec = totalDurationSeconds(tracks.map((t) => t.duration));
          return Column(
            children: [
              _coverHeader(tracks.length, totalSec),
              if (selecting) _selectionBar(tracks),
              if (_reorderMode)
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: Text('Drag the handles to rearrange. Changes save as you go.',
                      style: TextStyle(color: kMuted, fontSize: 12)),
                ),
              if (tracks.isNotEmpty && !selecting && !_reorderMode)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  child: Row(
                    children: [
                      PlayRoundButton(
                        onPressed: () => context.read<PlayerModel>().playQueue(
                              tracks,
                              playlistId: widget.playlistId,
                              // Honour this playlist's remembered shuffle preference.
                              // anchorStart:false → when shuffling, the whole list is
                              // randomized so the FIRST song is random too (not the
                              // playlist's original first track).
                              shuffle: _shufflePref,
                              anchorStart: false,
                            ),
                      ),
                      const SizedBox(width: 12),
                      // Per-playlist shuffle toggle (remembered); inverted colours when
                      // on. Does not touch the global shuffle or anything already playing.
                      ShuffleToggleButton(on: _shufflePref, onPressed: _toggleShufflePref),
                      const SizedBox(width: 12),
                      AddToQueueButton(tracks: tracks, shuffle: _shufflePref),
                      const SizedBox(width: 12),
                      DownloadToggleButton(
                          tracks: tracks, source: widget.playlistId, name: _name),
                    ],
                  ),
                ),
              Expanded(
                child: tracks.isEmpty
                    ? const Center(
                        child: Text('Empty playlist.\nAdd tracks with the ⋮ menu.',
                            textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
                      )
                    : _isDesktop
                        // Desktop: the columnar, sortable table (Added = playlist
                        // add date; no "Uploaded by"; X removes from the playlist).
                        ? TrackTable(
                            tracks: tracks,
                            addedAtById: _pl?.addedAt,
                            showUploadedBy: false,
                            onChanged: _load,
                            onRemove: showMenu ? (t) => _removeFromPlaylist(t.id) : null,
                            selectedIds: _selected,
                            onSelectToggle: _toggleSelect,
                            onReorder: canReorder && !selecting
                                ? (from, to) => _move(tracks, from, to)
                                : null,
                          )
                        : _reorderMode
                        ? _reorderList(tracks)
                        : ListView.builder(
                        itemCount: tracks.length,
                        itemBuilder: (context, i) => Dismissible(
                    key: ValueKey(tracks[i].id),
                    // Swipe-to-remove only for editors, and not while selecting.
                    direction: showMenu && !selecting
                        ? DismissDirection.endToStart
                        : DismissDirection.none,
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
                    child: TrackTile(
                      tracks: tracks,
                      index: i,
                      showDownload: true,
                      selectedIds: _selected,
                      onSelectToggle: _toggleSelect,
                    ),
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
