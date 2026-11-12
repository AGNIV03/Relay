import 'dart:convert';
import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../feature_models.dart';
import '../theme.dart';
import 'playlist_detail_screen.dart';

enum _Source { m3u, text, spotify }

/// Build a playlist from an M3U file, a pasted "Artist - Title" list, or a
/// Spotify playlist link. The server matches each entry against the library and
/// reports what it couldn't find.
class ImportPlaylistScreen extends StatefulWidget {
  const ImportPlaylistScreen({super.key});
  @override
  State<ImportPlaylistScreen> createState() => _ImportPlaylistScreenState();
}

class _ImportPlaylistScreenState extends State<ImportPlaylistScreen> {
  _Source _source = _Source.m3u;
  final _name = TextEditingController();
  final _text = TextEditingController();
  final _url = TextEditingController();
  String? _m3uName; // picked file name
  String? _m3uContent;
  bool _busy = false;
  String? _error;
  ImportResult? _result;

  @override
  void dispose() {
    _name.dispose();
    _text.dispose();
    _url.dispose();
    super.dispose();
  }

  Future<void> _pickM3u() async {
    final res = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['m3u', 'm3u8', 'txt'],
      withData: true,
    );
    final f = res?.files.singleOrNull;
    if (f == null) return;
    try {
      final bytes = f.bytes ?? (f.path != null ? await File(f.path!).readAsBytes() : null);
      if (bytes == null) throw 'No file data';
      final content = utf8.decode(bytes, allowMalformed: true);
      setState(() {
        _m3uName = f.name;
        _m3uContent = content;
        _error = null;
        if (_name.text.trim().isEmpty) {
          _name.text = f.name.replaceFirst(RegExp(r'\.(m3u8?|txt)$', caseSensitive: false), '');
        }
      });
    } catch (e) {
      setState(() => _error = "Couldn't read that file: $e");
    }
  }

  Future<void> _import() async {
    final name = _name.text.trim();
    String? content;
    String? url;
    switch (_source) {
      case _Source.m3u:
        content = _m3uContent;
        if (content == null || content.trim().isEmpty) {
          return setState(() => _error = 'Choose an M3U file first');
        }
      case _Source.text:
        content = _text.text;
        if (content.trim().isEmpty) {
          return setState(() => _error = 'Paste at least one "Artist - Title" line');
        }
      case _Source.spotify:
        url = _url.text.trim();
        if (!url.contains('spotify.com/playlist/') && !url.startsWith('spotify:playlist:')) {
          return setState(() => _error = 'Paste a Spotify playlist link (open.spotify.com/playlist/…)');
        }
    }
    if (name.isEmpty && _source != _Source.spotify) {
      return setState(() => _error = 'Give the playlist a name');
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await context.read<Api>().importPlaylist(
            name: name.isEmpty ? 'Imported playlist' : name,
            source: _source.name,
            content: content,
            url: url,
          );
      if (mounted) setState(() => _result = r);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openPlaylist(ImportResult r) {
    final name = _name.text.trim().isEmpty ? 'Imported playlist' : _name.text.trim();
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => PlaylistDetailScreen(playlistId: r.playlistId, name: name),
    ));
  }

  Widget _form() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        SegmentedButton<_Source>(
          segments: const [
            ButtonSegment(value: _Source.m3u, label: Text('M3U file'), icon: Icon(Icons.description_outlined)),
            ButtonSegment(value: _Source.text, label: Text('Paste list'), icon: Icon(Icons.notes)),
            ButtonSegment(value: _Source.spotify, label: Text('Spotify'), icon: Icon(Icons.link)),
          ],
          selected: {_source},
          showSelectedIcon: false,
          onSelectionChanged: _busy ? null : (s) => setState(() {
                _source = s.first;
                _error = null;
              }),
        ),
        const SizedBox(height: 20),
        TextField(
          controller: _name,
          decoration: InputDecoration(
            labelText: 'Playlist name',
            hintText: _source == _Source.spotify ? 'Optional' : null,
          ),
        ),
        const SizedBox(height: 16),
        switch (_source) {
          _Source.m3u => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              OutlinedButton.icon(
                onPressed: _busy ? null : _pickM3u,
                icon: const Icon(LucideIcons.upload, size: 18),
                label: Text(_m3uName ?? 'Choose an M3U file'),
              ),
              const SizedBox(height: 8),
              const Text(
                'Entries are matched by the #EXTINF "Artist - Title" line or the file name.',
                style: TextStyle(color: kMuted, fontSize: 12),
              ),
            ]),
          _Source.text => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(
                controller: _text,
                minLines: 6,
                maxLines: 14,
                decoration: const InputDecoration(
                  hintText: 'Daft Punk - One More Time\nRadiohead - Karma Police\n…',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 8),
              const Text('One song per line, as "Artist - Title" or just "Title".',
                  style: TextStyle(color: kMuted, fontSize: 12)),
            ]),
          _Source.spotify => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(
                controller: _url,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'Spotify playlist link',
                  hintText: 'https://open.spotify.com/playlist/…',
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'The playlist must be public. Songs are matched against your library; '
                'nothing is downloaded from Spotify.',
                style: TextStyle(color: kMuted, fontSize: 12),
              ),
            ]),
        },
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(_error!, style: const TextStyle(color: Color(0xFFEF4444))),
          ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: _busy ? null : _import,
          icon: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.playlist_add, size: 20),
          label: Text(_busy ? 'Matching songs…' : 'Import'),
        ),
      ],
    );
  }

  Widget _summary(ImportResult r) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: kPanel,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: kBorder),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(r.matched > 0 ? LucideIcons.checkCircle : Icons.error_outline,
                  color: r.matched > 0 ? kAccent : kMuted),
              const SizedBox(width: 10),
              Expanded(
                child: Text('Matched ${r.matched} of ${r.total} songs',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              ),
            ]),
            if (r.total > 0) ...[
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: LinearProgressIndicator(
                  minHeight: 6,
                  value: r.matched / r.total,
                  backgroundColor: kBorder,
                ),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => _openPlaylist(r),
              icon: const Icon(LucideIcons.listMusic, size: 18),
              label: const Text('Open playlist'),
            ),
          ]),
        ),
        if (r.unmatched.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 20, 4, 6),
            child: Text("Not found in your library (${r.unmatched.length})",
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ),
          for (final u in r.unmatched)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
              child: Row(children: [
                const Icon(Icons.remove_circle_outline, size: 16, color: kMuted),
                const SizedBox(width: 10),
                Expanded(child: Text(u, style: const TextStyle(color: kMuted))),
              ]),
            ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final r = _result;
    return Scaffold(
      appBar: AppBar(title: const Text('Import playlist')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: r == null ? _form() : _summary(r),
        ),
      ),
    );
  }
}
