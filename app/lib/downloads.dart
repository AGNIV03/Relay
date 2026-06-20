import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'models.dart';

/// Manages offline downloads of tracks to the device's documents directory.
/// Disabled on web (no local filesystem).
class DownloadManager extends ChangeNotifier {
  final Api api;
  final Set<String> _downloaded = {};
  final Set<String> _inProgress = {};
  Directory? _dir;

  DownloadManager(this.api);

  static const _kKey = 'downloaded_tracks';

  bool get supported => !kIsWeb;

  Future<void> init() async {
    if (!supported) return;
    _dir = await getApplicationDocumentsDirectory();
    final p = await SharedPreferences.getInstance();
    final saved = p.getStringList(_kKey) ?? [];
    // Verify the files still exist.
    for (final id in saved) {
      if (await File(_pathFor(id)).exists()) _downloaded.add(id);
    }
    notifyListeners();
  }

  String _pathFor(String trackId) => '${_dir!.path}/stream_$trackId.audio';

  bool isDownloaded(String id) => _downloaded.contains(id);
  bool isDownloading(String id) => _inProgress.contains(id);

  /// Returns a local file path if the track is downloaded, else null.
  String? localPath(String id) =>
      supported && _downloaded.contains(id) ? _pathFor(id) : null;

  Future<void> download(Track track) async {
    if (!supported || _downloaded.contains(track.id) || _inProgress.contains(track.id)) return;
    _inProgress.add(track.id);
    notifyListeners();
    try {
      final res = await http.get(Uri.parse(api.streamUrl(track.id)));
      if (res.statusCode == 200) {
        await File(_pathFor(track.id)).writeAsBytes(res.bodyBytes);
        _downloaded.add(track.id);
        await _save();
      }
    } finally {
      _inProgress.remove(track.id);
      notifyListeners();
    }
  }

  Future<void> remove(String trackId) async {
    if (!supported) return;
    final f = File(_pathFor(trackId));
    if (await f.exists()) await f.delete();
    _downloaded.remove(trackId);
    await _save();
    notifyListeners();
  }

  // ---- Whole-playlist download toggle ----
  bool allDownloaded(List<Track> tracks) =>
      tracks.isNotEmpty && tracks.every((t) => _downloaded.contains(t.id));
  int downloadedCount(List<Track> tracks) =>
      tracks.where((t) => _downloaded.contains(t.id)).length;

  /// Download every track in a playlist (skips ones already local).
  Future<void> downloadAll(List<Track> tracks) async {
    for (final t in tracks) {
      await download(t);
    }
  }

  /// Delete every downloaded file for a playlist's tracks.
  Future<void> removeAll(List<Track> tracks) async {
    for (final t in tracks) {
      await remove(t.id);
    }
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setStringList(_kKey, _downloaded.toList());
  }
}
