import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'models.dart';

/// A downloaded playlist, reconstructed from local metadata for offline use.
class OfflinePlaylist {
  final String id;
  final String name;
  final List<Track> tracks;
  OfflinePlaylist(this.id, this.name, this.tracks);
}

/// Manages offline downloads of tracks to the device's documents directory.
/// Disabled on web (no local filesystem).
///
/// Each downloaded track records the "sources" that want it kept — a playlist id,
/// the special `liked` key, or `manual` (individually downloaded). The file is
/// only deleted once no source references it, so a track shared across multiple
/// downloaded playlists is stored once and survives until all references drop.
///
/// Track metadata (title/artist/album) and cover art are also stored locally so
/// downloaded songs + playlists can be browsed and played with no connection.
class DownloadManager extends ChangeNotifier {
  final Api api;
  final Set<String> _downloaded = {};
  final Set<String> _inProgress = {};
  final Map<String, Set<String>> _sources = {};
  final Map<String, Map<String, dynamic>> _meta = {}; // trackId -> Track json
  final Map<String, ({String name, List<String> ids})> _playlists = {}; // source -> playlist
  Directory? _dir;

  DownloadManager(this.api);

  static const _kFiles = 'downloaded_tracks';
  static const _kSources = 'download_sources';
  static const _kMeta = 'download_meta';
  static const _kPlaylists = 'download_playlists';
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
    // Restore track metadata (for offline browsing/playback).
    final rawMeta = p.getString(_kMeta);
    if (rawMeta != null) {
      try {
        final map = jsonDecode(rawMeta) as Map<String, dynamic>;
        for (final e in map.entries) {
          _meta[e.key] = (e.value as Map).cast<String, dynamic>();
        }
      } catch (_) {}
    }
    _meta.removeWhere((k, _) => !_downloaded.contains(k)); // keep only live downloads
    // Restore downloaded-playlist metadata.
    final rawPl = p.getString(_kPlaylists);
    if (rawPl != null) {
      try {
        final map = jsonDecode(rawPl) as Map<String, dynamic>;
        for (final e in map.entries) {
          final v = e.value as Map;
          _playlists[e.key] =
              (name: v['name'] as String? ?? e.key, ids: (v['ids'] as List).cast<String>());
        }
      } catch (_) {}
    }
    notifyListeners();
  }

  String _pathFor(String trackId) => '${_dir!.path}/stream_$trackId.audio';
  String _coverPathFor(String trackId) => '${_dir!.path}/stream_cover_$trackId.jpg';

  bool isDownloaded(String id) => _downloaded.contains(id);
  bool isDownloading(String id) => _inProgress.contains(id);

  /// Returns a local file path if the track is downloaded, else null.
  String? localPath(String id) => supported && _downloaded.contains(id) ? _pathFor(id) : null;

  /// Local cover-art path if it was saved with the download, else null.
  String? localCoverPath(String id) {
    if (!supported || _dir == null) return null;
    final p = _coverPathFor(id);
    return File(p).existsSync() ? p : null;
  }

  // ---- Offline browsing ----
  bool get hasDownloads => _downloaded.isNotEmpty;

  List<Track> get offlineTracks {
    final list = _downloaded
        .map((id) => _meta[id])
        .whereType<Map<String, dynamic>>()
        .map((j) => Track.fromJson(j))
        .toList();
    list.sort((a, b) => a.title.toLowerCase().compareTo(b.title.toLowerCase()));
    return list;
  }

  List<OfflinePlaylist> get offlinePlaylists {
    final out = <OfflinePlaylist>[];
    for (final e in _playlists.entries) {
      final tracks = e.value.ids
          .where((id) => _downloaded.contains(id) && _meta.containsKey(id))
          .map((id) => Track.fromJson(_meta[id]!))
          .toList();
      if (tracks.isNotEmpty) out.add(OfflinePlaylist(e.key, e.value.name, tracks));
    }
    out.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return out;
  }

  // ---- Whole-list helpers ----
  bool allDownloaded(List<Track> tracks) =>
      tracks.isNotEmpty && tracks.every((t) => _downloaded.contains(t.id));
  int downloadedCount(List<Track> tracks) =>
      tracks.where((t) => _downloaded.contains(t.id)).length;

  /// Fetch the audio + cover once (no-op if already present). Does not touch sources.
  Future<void> _fetch(Track track) async {
    if (!supported || _downloaded.contains(track.id) || _inProgress.contains(track.id)) return;
    _inProgress.add(track.id);
    notifyListeners();
    try {
      final res = await http.get(Uri.parse(api.streamUrl(track.id)));
      if (res.statusCode == 200) {
        await File(_pathFor(track.id)).writeAsBytes(res.bodyBytes);
        _downloaded.add(track.id);
        await _fetchCover(track); // best-effort cover for offline display
      }
    } finally {
      _inProgress.remove(track.id);
      notifyListeners();
    }
  }

  Future<void> _fetchCover(Track track) async {
    try {
      final f = File(_coverPathFor(track.id));
      if (await f.exists()) return;
      final res = await http.get(Uri.parse(api.trackCoverUrl(track.id)));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        await f.writeAsBytes(res.bodyBytes);
      }
    } catch (_) {}
  }

  /// Delete the audio + cover if nothing references the track anymore.
  Future<void> _gc(String trackId) async {
    if ((_sources[trackId]?.isNotEmpty ?? false)) return;
    final f = File(_pathFor(trackId));
    if (await f.exists()) await f.delete();
    final c = File(_coverPathFor(trackId));
    if (await c.exists()) await c.delete();
    _downloaded.remove(trackId);
    _sources.remove(trackId);
    _meta.remove(trackId);
  }

  void _addSource(String trackId, String source) =>
      _sources.putIfAbsent(trackId, () => {}).add(source);

  // ---- Individual track download / remove ----
  Future<void> download(Track track) async {
    _addSource(track.id, manual);
    _meta[track.id] = track.toJson();
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
  Future<void> downloadAll(List<Track> tracks, String source, {String? name}) async {
    for (final t in tracks) {
      _addSource(t.id, source);
      _meta[t.id] = t.toJson();
      await _fetch(t);
    }
    // Record the playlist so it can be browsed offline (snapshot of name + order).
    if (source != manual) {
      _playlists[source] = (name: name ?? source, ids: tracks.map((t) => t.id).toList());
    }
    await _save();
  }

  Future<void> removeAll(List<Track> tracks, String source) async {
    _playlists.remove(source);
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
    await p.setString(_kMeta, jsonEncode(_meta));
    await p.setString(
      _kPlaylists,
      jsonEncode(_playlists.map((k, v) => MapEntry(k, {'name': v.name, 'ids': v.ids}))),
    );
  }
}
