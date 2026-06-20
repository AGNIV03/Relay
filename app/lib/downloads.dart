import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'models.dart';

/// Manages offline downloads of tracks to the device's documents directory.
/// Disabled on web (no local filesystem).
///
/// Each downloaded track records the "sources" that want it kept — a playlist id,
/// the special `liked` key, or `manual` (individually downloaded). The file is
/// only deleted once no source references it, so a track shared across multiple
/// downloaded playlists is stored once and survives until all references drop.
class DownloadManager extends ChangeNotifier {
  final Api api;
  final Set<String> _downloaded = {};
  final Set<String> _inProgress = {};
  final Map<String, Set<String>> _sources = {};
  Directory? _dir;

  DownloadManager(this.api);

  static const _kFiles = 'downloaded_tracks';
  static const _kSources = 'download_sources';
  static const manual = 'manual';

  bool get supported => !kIsWeb;

  Future<void> init() async {
    if (!supported) return;
    _dir = await getApplicationDocumentsDirectory();
    final p = await SharedPreferences.getInstance();
    final saved = p.getStringList(_kFiles) ?? [];
    for (final id in saved) {
      if (await File(_pathFor(id)).exists()) _downloaded.add(id);
    }
    // Restore sources; default any legacy downloads (no source recorded) to manual.
    final rawSources = p.getString(_kSources);
    if (rawSources != null) {
      try {
        final map = jsonDecode(rawSources) as Map<String, dynamic>;
        for (final e in map.entries) {
          _sources[e.key] = (e.value as List).map((s) => s as String).toSet();
        }
      } catch (_) {}
    }
    for (final id in _downloaded) {
      _sources.putIfAbsent(id, () => {manual});
    }
    notifyListeners();
  }

  String _pathFor(String trackId) => '${_dir!.path}/stream_$trackId.audio';

  bool isDownloaded(String id) => _downloaded.contains(id);
  bool isDownloading(String id) => _inProgress.contains(id);

  /// Returns a local file path if the track is downloaded, else null.
  String? localPath(String id) => supported && _downloaded.contains(id) ? _pathFor(id) : null;

  // ---- Whole-list helpers ----
  bool allDownloaded(List<Track> tracks) =>
      tracks.isNotEmpty && tracks.every((t) => _downloaded.contains(t.id));
  int downloadedCount(List<Track> tracks) =>
      tracks.where((t) => _downloaded.contains(t.id)).length;

  /// Fetch the file once (no-op if already present). Does not touch sources.
  Future<void> _fetch(Track track) async {
    if (!supported || _downloaded.contains(track.id) || _inProgress.contains(track.id)) return;
    _inProgress.add(track.id);
    notifyListeners();
    try {
      final res = await http.get(Uri.parse(api.streamUrl(track.id)));
      if (res.statusCode == 200) {
        await File(_pathFor(track.id)).writeAsBytes(res.bodyBytes);
        _downloaded.add(track.id);
      }
    } finally {
      _inProgress.remove(track.id);
      notifyListeners();
    }
  }

  /// Delete the file if nothing references it anymore.
  Future<void> _gc(String trackId) async {
    if ((_sources[trackId]?.isNotEmpty ?? false)) return;
    final f = File(_pathFor(trackId));
    if (await f.exists()) await f.delete();
    _downloaded.remove(trackId);
    _sources.remove(trackId);
  }

  void _addSource(String trackId, String source) =>
      _sources.putIfAbsent(trackId, () => {}).add(source);

  // ---- Individual track download / remove ----
  Future<void> download(Track track) async {
    _addSource(track.id, manual);
    await _fetch(track);
    await _save();
  }

  Future<void> remove(String trackId) async {
    _sources[trackId]?.remove(manual);
    await _gc(trackId);
    await _save();
    notifyListeners();
  }

  // ---- Whole-playlist (or Liked Songs) download toggle ----
  Future<void> downloadAll(List<Track> tracks, String source) async {
    for (final t in tracks) {
      _addSource(t.id, source);
      await _fetch(t);
    }
    await _save();
  }

  Future<void> removeAll(List<Track> tracks, String source) async {
    for (final t in tracks) {
      _sources[t.id]?.remove(source);
      await _gc(t.id);
    }
    await _save();
    notifyListeners();
  }

  /// Called when a track is removed from a playlist — drop that playlist's hold,
  /// and delete the download if no other source still needs it.
  Future<void> onRemovedFromSource(String trackId, String source) async {
    _sources[trackId]?.remove(source);
    await _gc(trackId);
    await _save();
    notifyListeners();
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setStringList(_kFiles, _downloaded.toList());
    await p.setString(
      _kSources,
      jsonEncode(_sources.map((k, v) => MapEntry(k, v.toList()))),
    );
  }
}
