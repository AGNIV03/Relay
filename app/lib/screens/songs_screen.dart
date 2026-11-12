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
import '../feature_models.dart';
import '../models.dart';
import '../settings.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/track_table.dart';
import '../widgets/track_tile.dart';
import '../widgets/upload_progress.dart';
import 'album_detail_screen.dart';
import 'artist_screen.dart';
import 'playlist_detail_screen.dart';

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
  UploadJob? _uploadJob; // the running/last upload (its progress sheet can reopen)
  // Artists / albums / playlists matching the current search (grouped results).
  SearchResults _groups = SearchResults.empty;
  int _loadSeq = 0; // drops stale search responses

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
    _searchFocus.addListener(_onFocusChange);
    AppSettings.instance.addListener(_onSettings);
    _load("");
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchFocus.removeListener(_onFocusChange);
    AppSettings.instance.removeListener(_onSettings);
    _controller.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  void _onSettings() {
    if (mounted) setState(() {}); // recent searches changed
  }

  /// Leaving the search field (scrolling, tapping a result, playing a song)
  /// records the query as a recent search; focusing it shows the recents.
  void _onFocusChange() {
    if (!_searchFocus.hasFocus) _rememberQuery();
    if (mounted) setState(() {});
  }

  void _rememberQuery() {
    final q = _controller.text.trim();
    if (q.length >= 2) AppSettings.instance.addRecentSearch(q);
  }

  void _runRecent(String q) {
    _controller.text = q;
    _controller.selection = TextSelection.collapsed(offset: q.length);
    _debounce?.cancel();
    AppSettings.instance.addRecentSearch(q);
    _searchFocus.unfocus();
    setState(() => _loading = true);
    _load(q);
  }

  Future<void> _load(String q) async {
    final seq = ++_loadSeq;
    final api = context.read<Api>();
    final groupsF = q.trim().isEmpty
        ? Future.value(SearchResults.empty)
        : api.search(q).catchError((_) => SearchResults.empty);
    final tracks = await api.tracks(q: q).catchError((_) => <Track>[]);
    final groups = await groupsF;
    if (!mounted || seq != _loadSeq) return;
    setState(() {
      _tracks = tracks;
      _groups = groups;
      if (q.isEmpty) _allTracks = tracks; // keep the full library for the play context
      _loading = false;
      _selected.retainWhere((id) => tracks.any((t) => t.id == id));
    });
  }

  void _open(Widget page) {
    _rememberQuery();
    FocusManager.instance.primaryFocus?.unfocus();
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));
  }

  /// Recent searches, shown while the (empty) search field has focus.
  Widget _recentSearches() {
    final recent = AppSettings.instance.recentSearches;
    // Counts as "inside" the search field, so tapping a recent doesn't first
    // unfocus the field (which would hide this list mid-tap).
    return TextFieldTapRegion(
      child: ListView(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 8, 0),
            child: Row(children: [
              const Expanded(
                child: Text('Recent searches',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
              ),
              TextButton(
                onPressed: AppSettings.instance.clearRecentSearches,
                child: const Text('Clear all'),
              ),
            ]),
          ),
          for (final q in recent)
            ListTile(
              dense: true,
              leading: const Icon(Icons.history, size: 20, color: kMuted),
              title: Text(q, maxLines: 1, overflow: TextOverflow.ellipsis),
              trailing: IconButton(
                tooltip: 'Remove',
                icon: const Icon(LucideIcons.x, size: 16, color: kMuted),
                onPressed: () => AppSettings.instance.removeRecentSearch(q),
              ),
              onTap: () => _runRecent(q),
            ),
        ],
      ),
    );
  }

  /// Grouped results (Artists / Albums / Playlists) above the Songs list.
  Widget _groupedResults() {
    final api = context.read<Api>();
    final g = _groups;
    Widget section(String label, List<Widget> chips) => Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(children: [
            SizedBox(
              width: 76,
              child: Padding(
                padding: const EdgeInsets.only(left: 16),
                child: Text(label,
                    style: const TextStyle(color: kMuted, fontSize: 12, fontWeight: FontWeight.w600)),
              ),
            ),
            Expanded(
              child: SizedBox(
                height: 38,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.only(right: 12),
                  itemCount: chips.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 8),
                  itemBuilder: (_, i) => chips[i],
                ),
              ),
            ),
          ]),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (g.artists.isNotEmpty)
          section('Artists', [
            for (final a in g.artists)
              _ResultChip(
                leading: const CircleAvatar(
                    radius: 13,
                    backgroundColor: kBorder,
                    child: Icon(LucideIcons.user, size: 15, color: kMuted)),
                label: a.name,
                onTap: () => _open(ArtistScreen(artistId: a.id, artistName: a.name)),
              ),
          ]),
        if (g.albums.isNotEmpty)
          section('Albums', [
            for (final al in g.albums)
              _ResultChip(
                leading: Cover(url: api.albumCoverUrl(al.id), size: 26, radius: 4),
                label: al.artist == null ? al.title : '${al.title} · ${al.artist!.name}',
                onTap: () => _open(AlbumDetailScreen(albumId: al.id)),
              ),
          ]),
        if (g.playlists.isNotEmpty)
          section('Playlists', [
            for (final pl in g.playlists)
              _ResultChip(
                leading: Cover(url: api.playlistCoverUrl(pl.id), size: 26, radius: 4),
                label: pl.ownerName == null ? pl.name : '${pl.name} · ${pl.ownerName}',
                onTap: () => _open(PlaylistDetailScreen(playlistId: pl.id, name: pl.name)),
              ),
          ]),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 2, 16, 4),
          child: Text('Songs',
              style: TextStyle(color: kMuted, fontSize: 12, fontWeight: FontWeight.w600)),
        ),
      ],
    );
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
    if (files.isEmpty || !mounted) return;
    final paths = files.map((f) => f.path!).toList();
    final job = UploadJob(paths);
    setState(() {
      _uploading = true;
      _uploadJob = job;
    });
    // Per-file progress; closing the sheet keeps the upload going (the upload
    // button reopens it).
    showUploadProgress(context, job);
    try {
      // Handles any count/size: small files batched under the CDN cap, large
      // files chunked individually.
      final r = await job.run(api);
      final added = r['added'] as int? ?? 0;
      final failed = r['failed'] as int? ?? 0;
      final dupes = r['duplicates'] as int? ?? 0;
      final rejected = (r['rejected'] as List?)?.cast<({String name, String reason})>() ?? [];
      if (!mounted) return;
      // Broken files (no playable audio) are refused by the server: say which
      // one and why, so the user knows to find a good copy.
      final why = rejected.isEmpty
          ? ''
          : rejected.length == 1
              ? '\n${rejected.first.name}: ${rejected.first.reason}'
              : '\n${rejected.length} files had no playable audio (truncated or corrupt)';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        duration: Duration(seconds: rejected.isEmpty ? 4 : 8),
        content: Text('Uploaded $added song${added == 1 ? '' : 's'}'
            '${dupes > 0 ? ', $dupes already in library' : ''}'
            '${failed > 0 ? ', $failed rejected' : ''}$why'),
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
    final searching = _controller.text.trim().isNotEmpty;
    final showRecent = _searchFocus.hasFocus &&
        !searching &&
        AppSettings.instance.recentSearches.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Songs'),
        actions: [
          _sortButton(),
          IconButton(
            tooltip: _uploading ? 'Upload progress' : 'Upload',
            onPressed: _uploading
                ? () => showUploadProgress(context, _uploadJob!)
                : _upload,
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
              onChanged: (q) {
                _onSearch(q);
                setState(() {}); // toggles the clear button / recent searches
              },
              onSubmitted: (_) => _rememberQuery(),
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
          if (showRecent)
            Expanded(child: _recentSearches())
          else ...[
          if (searching && _groups.hasGroups && _selected.isEmpty) _groupedResults(),
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
        ],
      ),
    );
  }
}

/// A compact tappable result (artist / album / playlist) in the grouped search.
class _ResultChip extends StatelessWidget {
  final Widget leading;
  final String label;
  final VoidCallback onTap;
  const _ResultChip({required this.leading, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: kPanel2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(999),
        side: const BorderSide(color: kBorder),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 6, 14, 6),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            leading,
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 220),
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
            ),
          ]),
        ),
      ),
    );
  }
}
