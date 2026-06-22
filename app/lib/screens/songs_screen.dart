import 'dart:async';
import 'dart:io' show Platform;
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

class SongsScreen extends StatefulWidget {
  const SongsScreen({super.key});
  @override
  State<SongsScreen> createState() => _SongsScreenState();
}

class _SongsScreenState extends State<SongsScreen> {
  final _controller = TextEditingController();
  Timer? _debounce;
  List<Track> _tracks = [];
  bool _loading = true;
  bool _uploading = false;
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    _load("");
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _load(String q) async {
    final tracks = await context.read<Api>().tracks(q: q).catchError((_) => <Track>[]);
    if (!mounted) return;
    setState(() {
      _tracks = tracks;
      _loading = false;
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
      allowedExtensions: ['mp3', 'flac'],
      allowMultiple: true,
    );
    final files = result?.files.where((f) => f.path != null).toList() ?? [];
    if (files.isEmpty) return;
    // Small files batch in one multipart request; large files (over the CDN's
    // request-body cap) upload individually in chunks.
    final small = files.where((f) => f.size < Api.chunkThreshold).map((f) => f.path!).toList();
    final large = files.where((f) => f.size >= Api.chunkThreshold).toList();
    setState(() => _uploading = true);
    try {
      var added = 0, failed = 0, dupes = 0;
      if (small.isNotEmpty) {
        final r = await api.uploadTracks(small);
        added += (r['added'] ?? 0) as int;
        failed += (r['failed'] ?? 0) as int;
        dupes += (r['duplicates'] ?? 0) as int;
      }
      for (final f in large) {
        try {
          final r = await api.uploadTrackChunked(f.path!);
          added += (r['added'] ?? 0) as int;
          failed += (r['failed'] ?? 0) as int;
          dupes += (r['duplicates'] ?? 0) as int;
        } catch (_) {
          failed += 1;
        }
      }
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

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  onChanged: _onSearch,
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
                              setState(() {});
                            },
                          ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                onPressed: _uploading ? null : _upload,
                icon: _uploading
                    ? const SizedBox(
                        width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(LucideIcons.upload, size: 18),
                label: Text(_uploading ? 'Uploading…' : 'Upload'),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: _refreshing ? null : _refresh,
                icon: _refreshing
                    ? const SizedBox(
                        width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(LucideIcons.refreshCw, size: 18),
                label: Text(_refreshing ? 'Refreshing…' : 'Refresh'),
              ),
            ],
          ),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _tracks.isEmpty
                  ? const Center(child: Text("No songs", style: TextStyle(color: kMuted)))
                  : _isDesktop
                      // Desktop/web: columnar table (Album / Uploaded by / Added).
                      ? TrackTable(tracks: _tracks, onChanged: () => _load(_controller.text))
                      // Mobile: compact list, no "uploaded by".
                      : ListView.builder(
                          itemCount: _tracks.length,
                          itemBuilder: (_, i) => TrackTile(
                            tracks: _tracks,
                            index: i,
                            showDownload: true,
                            onChanged: () => _load(_controller.text),
                          ),
                        ),
        ),
      ],
    );
  }
}
