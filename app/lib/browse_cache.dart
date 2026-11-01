import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

/// On-disk copy of what the Android Auto browse tree last fetched live (playlist
/// list, liked, most played, songs, recents, each opened playlist's tracks), so
/// the car can still browse the library when the phone is offline or the server
/// is down instead of showing empty lists.
///
/// One small JSON file per node under `<documents>/aa_browse_cache/` (not
/// SharedPreferences: those load wholesale into memory on every launch). Each
/// file records its [owner] (`<server>|<user id>`), so another account or server
/// never sees it. Lists are capped at [maxEntries]; identical rewrites are
/// skipped, and writes to the same node are serialized so they can't interleave.
class BrowseCache {
  BrowseCache._();
  static final instance = BrowseCache._();

  /// Max entries kept per node (a playlist / track list).
  static const maxEntries = 500;

  Directory? _dir;
  final Map<String, ({String owner, String raw})> _mem = {}; // key -> last read/written
  final Map<String, Future<void>> _writes = {}; // key -> tail of its write chain

  bool get supported => !kIsWeb;

  Future<Directory?> _directory() async {
    if (!supported) return null;
    if (_dir != null) return _dir;
    final docs = await getApplicationDocumentsDirectory();
    final d = Directory('${docs.path}/aa_browse_cache');
    if (!await d.exists()) await d.create(recursive: true);
    return _dir = d;
  }

  // Keys are like `liked` or `pl:<id>`; ids are alphanumeric, so mapping every
  // other character to `_` can't make two nodes collide.
  static String _fileName(String key) => '${key.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_')}.json';

  /// The cached entries for [key], or null if none were stored for [owner].
  Future<List<Map<String, dynamic>>?> read(String key, String owner) async {
    try {
      var hit = _mem[key];
      if (hit == null) {
        final d = await _directory();
        if (d == null) return null;
        final f = File('${d.path}/${_fileName(key)}');
        if (!await f.exists()) return null;
        final data = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
        hit = (owner: data['owner'] as String? ?? '', raw: jsonEncode(data['items']));
        _mem[key] = hit;
      }
      if (hit.owner != owner) return null;
      return (jsonDecode(hit.raw) as List).map((e) => (e as Map).cast<String, dynamic>()).toList();
    } catch (e) {
      debugPrint('[AA] cache read "$key" failed: $e');
      return null;
    }
  }

  /// Store [items] (capped to [maxEntries]) as [key]'s latest copy for [owner].
  Future<void> write(String key, String owner, List<Map<String, dynamic>> items) {
    final raw = jsonEncode(items.length > maxEntries ? items.sublist(0, maxEntries) : items);
    final prev = _mem[key];
    if (prev != null && prev.owner == owner && prev.raw == raw) return Future.value();
    _mem[key] = (owner: owner, raw: raw);
    final next = (_writes[key] ?? Future.value()).then((_) async {
      final d = await _directory();
      if (d == null) return;
      // Write-then-rename so a crash mid-write never leaves a truncated file.
      final f = File('${d.path}/${_fileName(key)}');
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString('{"owner":${jsonEncode(owner)},"items":$raw}', flush: true);
      await tmp.rename(f.path);
    }).catchError((Object e) {
      debugPrint('[AA] cache write "$key" failed: $e');
    });
    _writes[key] = next;
    return next;
  }

  /// Drop cached playlist contents (`pl:<id>`) for playlists no longer in the
  /// user's list, so the cache can't grow without bound as playlists come and go.
  Future<void> retainPlaylists(Iterable<String> ids) async {
    try {
      final d = await _directory();
      if (d == null) return;
      final keep = {for (final id in ids) _fileName('pl:$id')};
      _mem.removeWhere((k, _) => k.startsWith('pl:') && !keep.contains(_fileName(k)));
      await for (final e in d.list()) {
        if (e is! File) continue;
        final name = e.uri.pathSegments.last;
        if (name.startsWith('pl_') && name.endsWith('.json') && !keep.contains(name)) {
          try {
            await e.delete();
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
}
