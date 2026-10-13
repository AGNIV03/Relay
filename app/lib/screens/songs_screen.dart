import 'dart:async';
import 'dart:io' show Platform;
import 'dart:math' show Random;
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_state.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/track_table.dart';
import '../widgets/track_tile.dart';

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

enum _SortField { random, title, artist, album, added }

class SongsScreen extends StatefulWidget {
  const SongsScreen({super.key});
  @override
  State<SongsScreen> createState() => _SongsScreenState();
}

class _SongsScreenState extends State<SongsScreen> {
  final _controller = TextEditingController();
  final _searchFocus = FocusNode();
  Timer? _debounce;
  List<Track> _tracks = []; // current display (filtered by the search server-side)
  List<Track> _allTracks = []; // full unfiltered library — the queue context for search results
  bool _loading = true;
  bool _uploading = false;
  bool _refreshing = false;
  // Songs default to a random order. A fixed per-session seed keeps that order
  // stable across rebuilds; tapping "Shuffle" in the sort menu reshuffles it.
  _SortField _sortField = _SortField.random;
  bool _sortAsc = true;
  int _shuffleSeed = DateTime.now().millisecondsSinceEpoch;
  final Set<String> _selected = {}; // multi-select on the songs list

  List<Track> _sorted(List<Track> list) {
    if (_sortField == _SortField.random) {
      return List<Track>.of(list)..shuffle(Random(_shuffleSeed));
    }
    String key(Track t) {
      switch (_sortField) {
        case _SortField.random:
          return ''; // unreachable (handled above), keeps the switch exhaustive
        case _SortField.title:
          return t.title.toLowerCase();
        case _SortField.artist:
          return t.artistName.toLowerCase();
        case _SortField.album:
          return t.albumTitle.toLowerCase();
        case _SortField.added:
          return t.createdAt ?? '';
      }
    }

    final l = List<Track>.of(list)..sort((a, b) => key(a).compareTo(key(b)));
    return _sortAsc ? l : l.reversed.toList();
  }

  void _toggleSelect(Track t) => setState(() {
        if (!_selected.remove(t.id)) _selected.add(t.id);
      });

  void _clearSelection() => setState(_selected.clear);

  void _selectAll() => setState(() {
        if (_selected.length == _tracks.length) {
          _selected.clear();
        } else {
          _selected
            ..clear()
            ..addAll(_tracks.map((t) => t.id));
        }
      });

  Future<void> _bulkDelete() async {
    final ids = _selected.toList();
    if (ids.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kPanel,
        title: Text('Delete ${ids.length} song${ids.length == 1 ? '' : 's'}?'),
        content: const Text('The selected songs will be permanently removed from the '
            'server, including the files. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete', style: TextStyle(color: Color(0xFFEF4444))),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      final r = await context.read<Api>().bulkDeleteTracks(ids);
      if (!mounted) return;
      final deleted = r['deleted'] ?? 0;
      final forbidden = r['forbidden'] ?? 0;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Deleted $deleted song${deleted == 1 ? '' : 's'}'
            '${forbidden > 0 ? ', $forbidden skipped (not yours)' : ''}'),
      ));
      _clearSelection();
      _load(_controller.text);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Delete failed: $e')));
      }
    }
  }

  Future<void> _bulkAddToPlaylist() async {
    final ids = _selected.toList();
    if (ids.isEmpty) return;
    final api = context.read<Api>();
    final playlists = await api.playlists();
    if (!mounted) return;
    await showModalBottomSheet(
      context: context,
      backgroundColor: kPanel,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text('Add ${ids.length} song${ids.length == 1 ? '' : 's'} to playlist',
                  style: const TextStyle(fontWeight: FontWeight.bold)),
            ),
            ListTile(
              leading: const Icon(LucideIcons.plus, size: 18, color: kAccent),
              title: const Text('New playlist…', style: TextStyle(color: kAccent)),
              onTap: () async {
                Navigator.pop(ctx);
                final name = await promptPlaylistName(context);
                if (name == null) return;
                String msg;
                try {
                  final id = await api.createPlaylist(name);
                  final added = await api.addManyToPlaylist(id, ids);
                  msg = 'Created "$name" · added $added';
                } catch (_) {
                  msg = "Couldn't create playlist";
                }
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
                  );
                  _clearSelection();
                }
              },
            ),
            if (playlists.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('No other playlists yet', style: TextStyle(color: kMuted)),
              ),
            ...playlists.map((pl) => ListTile(
                  leading: const Icon(LucideIcons.listMusic, size: 18),
                  title: Text(pl.name),
                  onTap: () async {
                    String msg;
                    try {
                      final added = await api.addManyToPlaylist(pl.id, ids);
                      final skipped = ids.length - added;
                      msg = 'Added $added to ${pl.name}'
                          '${skipped > 0 ? ' ($skipped already there)' : ''}';
                    } catch (_) {
                      msg = "Couldn't add to playlist";
                    }
                    if (ctx.mounted) Navigator.pop(ctx);
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
                      );
                      _clearSelection();
                    }
                  },
                )),
          ],
        ),
      ),
    );
  }

  Widget _selectionBar() {
    final n = _selected.length;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: kPanel2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: kBorder),
      ),
      child: Row(
        children: [
          IconButton(
            onPressed: _clearSelection,
            icon: const Icon(LucideIcons.x, size: 18),
            tooltip: 'Clear selection',
          ),
          Text('$n selected', style: const TextStyle(fontWeight: FontWeight.w600)),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              reverse: true,
              child: Row(
                children: [
                  TextButton.icon(
                    onPressed: _bulkAddToPlaylist,
                    icon: const Icon(LucideIcons.listPlus, size: 18),
                    label: const Text('Add to playlist'),
                  ),
                  TextButton.icon(
                    onPressed: _bulkDelete,
                    icon: const Icon(LucideIcons.trash2, size: 18, color: Color(0xFFEF4444)),
                    label: const Text('Delete', style: TextStyle(color: Color(0xFFEF4444))),
                  ),
                  TextButton(
                    onPressed: _selectAll,
                    child: Text(n == _tracks.length ? 'Unselect all' : 'Select all'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    _load("");
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  Future<void> _load(String q) async {
    final tracks = await context.read<Api>().tracks(q: q).catchError((_) => <Track>[]);
    if (!mounted) return;
    setState(() {
      _tracks = tracks;
      if (q.isEmpty) _allTracks = tracks; // keep the full library for the play context
      _loading = false;
      _selected.retainWhere((id) => tracks.any((t) => t.id == id));
    });
  }

  void _onSearch(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => _load(q));
  }

  /// Refresh the library. Admins trigger a full server rescan (picks up files
  /// added/removed on disk) then reload; everyone else just reloads the list.
  Future<void> _refresh() async {
    final api = context.read<Api>();
    final isAdmin = context.read<AppState>().user?.isAdmin ?? false;
    setState(() => _refreshing = true);
    try {
      if (isAdmin) {
        await api.triggerScan().catchError((_) {});
        for (var i = 0; i < 60; i++) {
          await Future.delayed(const Duration(seconds: 1));
          if (!await api.scanRunning().catchError((_) => false)) break;
        }
      }
      await _load(_controller.text);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> _upload() async {
    final api = context.read<Api>();
    final appState = context.read<AppState>();
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav'],
      allowMultiple: true,
    );
    final files = result?.files.where((f) => f.path != null).toList() ?? [];
    if (files.isEmpty) return;
    final paths = files.map((f) => f.path!).toList();
    setState(() => _uploading = true);
    try {
      // Handles any count/size: small files batched under the CDN cap, large
      // files chunked individually.
      final r = await api.uploadManyTracks(paths);
      final added = r['added'] ?? 0;
      final failed = r['failed'] ?? 0;
      final dupes = r['duplicates'] ?? 0;
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Uploaded $added song${added == 1 ? '' : 's'}'
            '${dupes > 0 ? ', $dupes already in library' : ''}'
            '${failed > 0 ? ', $failed rejected' : ''}'),
      ));
      appState.reloadLiked(); // uploads are auto-liked — refresh hearts
      _load(_controller.text);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Upload failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Widget _sortButton() {
    const labels = {
      _SortField.random: 'Shuffle',
      _SortField.title: 'Title',
      _SortField.artist: 'Artist',
      _SortField.album: 'Album',
      _SortField.added: 'Date added',
    };
    return PopupMenuButton<_SortField>(
      icon: const Icon(LucideIcons.arrowDownUp, size: 20),
      tooltip: 'Sort',
      color: kPanel2,
      onSelected: (f) => setState(() {
        if (f == _SortField.random) {
          // Tapping Shuffle (re)randomizes the order.
          _sortField = _SortField.random;
          _shuffleSeed = DateTime.now().millisecondsSinceEpoch;
        } else if (_sortField == f) {
          _sortAsc = !_sortAsc; // second tap on the same field flips direction
        } else {
          _sortField = f;
          _sortAsc = true;
        }
      }),
      itemBuilder: (_) => [
        for (final e in labels.entries)
          PopupMenuItem(
            value: e.key,
            child: Row(children: [
              Expanded(
                child: Text(e.value,
                    style: TextStyle(color: _sortField == e.key ? kAccent : null)),
              ),
              if (_sortField == e.key)
                Icon(
                    e.key == _SortField.random
                        ? LucideIcons.shuffle
                        : (_sortAsc ? LucideIcons.arrowUp : LucideIcons.arrowDown),
                    size: 15,
                    color: kAccent),
            ]),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final display = _sorted(_tracks);
    final queueCtx = _sorted(_allTracks);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Songs'),
        actions: [
          _sortButton(),
          IconButton(
            tooltip: 'Upload',
            onPressed: _uploading ? null : _upload,
            icon: _uploading
                ? const SizedBox(
                    width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(LucideIcons.upload, size: 20),
          ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refreshing ? null : _refresh,
            icon: _refreshing
                ? const SizedBox(
                    width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(LucideIcons.refreshCw, size: 20),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
            child: TextField(
              controller: _controller,
              focusNode: _searchFocus,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              onTapOutside: (_) => _searchFocus.unfocus(),
              decoration: InputDecoration(
                prefixIcon: const Icon(LucideIcons.search, size: 18),
                hintText: "Search songs, artists, albums…",
                suffixIcon: _controller.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(LucideIcons.x, size: 18),
                        onPressed: () {
                          _controller.clear();
                          _load("");
                          _searchFocus.unfocus();
                          setState(() {});
                        },
                      ),
              ),
            ),
          ),
          if (_isDesktop && display.isNotEmpty && _selected.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                'Click and hold or right click to select multiple tracks',
                style: TextStyle(color: kMuted, fontSize: 12, fontStyle: FontStyle.italic),
              ),
            ),
          if (_selected.isNotEmpty) _selectionBar(),
          Expanded(
            // Dismiss the search keyboard/cursor when the user scrolls the list.
            child: NotificationListener<ScrollNotification>(
              onNotification: (n) {
                if (n is ScrollStartNotification) {
                  FocusManager.instance.primaryFocus?.unfocus();
                }
                return false;
              },
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : display.isEmpty
                      ? const Center(child: Text("No songs", style: TextStyle(color: kMuted)))
                      : _isDesktop
                          // Desktop/web: columnar table (Album / Uploaded by / Added).
                          ? TrackTable(
                              tracks: display,
                              onChanged: () => _load(_controller.text),
                              selectedIds: _selected,
                              onSelectToggle: _toggleSelect,
                            )
                          // Mobile: compact list. Playing a track queues the whole
                          // library (queueCtx) from that track, not just the filter.
                          : ListView.builder(
                              itemCount: display.length,
                              itemBuilder: (_, i) => TrackTile(
                                tracks: display,
                                index: i,
                                showDownload: true,
                                queueContext: queueCtx,
                                onChanged: () => _load(_controller.text),
                                selectedIds: _selected,
                                onSelectToggle: _toggleSelect,
                              ),
                            ),
            ),
          ),
        ],
      ),
    );
  }
}
