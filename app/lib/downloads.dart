import 'dart:async';
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
/// Track metadata (title/artist/album), cover art and (when available) lyrics are
/// stored locally so downloaded songs + playlists can be browsed, played and have
/// their lyrics shown with no connection.
///
/// Downloads run through a SINGLE global FIFO queue processed one at a time, so
/// tapping a playlist's Download button repeatedly can never spawn parallel
/// downloads. Each file is fetched resiliently: on a flaky/slow network it retries
/// with backoff and resumes the partial file via an HTTP Range request rather than
/// failing outright.
class DownloadManager extends ChangeNotifier {
  final Api api;
  final Set<String> _downloaded = {};
  final Set<String> _active = {}; // the track currently downloading (0 or 1)
  final List<Track> _pending = []; // FIFO queue waiting to download
  final Set<String> _queuedIds = {}; // ids present in _pending (fast lookup)
  bool _working = false; // a worker loop is draining the queue
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
    // Clean up any stray partial files left by an interrupted download whose
    // track is no longer referenced.
    await _sweepOrphanParts();
    notifyListeners();
  }

  String _pathFor(String trackId) => '${_dir!.path}/stream_$trackId.audio';
  String _partPathFor(String trackId) => '${_dir!.path}/stream_$trackId.audio.part';
  String _coverPathFor(String trackId) => '${_dir!.path}/stream_cover_$trackId.jpg';
  String _lyricsPathFor(String trackId) => '${_dir!.path}/stream_lyrics_$trackId.json';

  bool isDownloaded(String id) => _downloaded.contains(id);
  // "Downloading" for the UI means actively downloading OR waiting in the queue —
  // both show a spinner so the user sees pending work and repeat taps are a no-op.
  bool isDownloading(String id) => _active.contains(id) || _queuedIds.contains(id);

  /// Returns a local file path if the track is downloaded, else null.
  String? localPath(String id) => supported && _downloaded.contains(id) ? _pathFor(id) : null;

  /// Local cover-art path if it was saved with the download, else null.
  String? localCoverPath(String id) {
    if (!supported || _dir == null) return null;
    final p = _coverPathFor(id);
    return File(p).existsSync() ? p : null;
  }

  /// Locally-saved lyrics for a downloaded track, else null (offline lyrics).
  Lyrics? localLyrics(String id) {
    if (!supported || _dir == null) return null;
    try {
      final f = File(_lyricsPathFor(id));
      if (!f.existsSync()) return null;
      final json = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
      return Lyrics.fromJson(json);
    } catch (_) {
      return null;
    }
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
  // Any track in [tracks] still downloading or queued → the whole-list button
  // should show a working state.
  bool anyPending(List<Track> tracks) =>
      tracks.any((t) => _active.contains(t.id) || _queuedIds.contains(t.id));

  // ---- Download queue ----
  /// Add a track to the global download queue (idempotent): already downloaded,
  /// active or queued → no-op. Starts the single worker if idle.
  void _enqueue(Track t) {
    if (!supported) return;
    if (_downloaded.contains(t.id) || _active.contains(t.id) || _queuedIds.contains(t.id)) {
      return;
    }
    _pending.add(t);
    _queuedIds.add(t.id);
    notifyListeners();
    _pump();
  }

  /// Single worker: drains the queue one track at a time. Guarded by [_working]
  /// so there is only ever one download in flight no matter how many times a
  /// Download button is tapped.
  Future<void> _pump() async {
    if (_working) return;
    _working = true;
    try {
      while (_pending.isNotEmpty) {
        final t = _pending.removeAt(0);
        _queuedIds.remove(t.id);
        if (_downloaded.contains(t.id)) continue;
        _active.add(t.id);
        notifyListeners();
        try {
          await _fetchResilient(t);
          _downloaded.add(t.id);
          await _fetchCover(t); // best-effort cover for offline display
          await _fetchLyrics(t); // best-effort lyrics for offline display
        } catch (e) {
          // Keep the recorded source so the user can retry later (re-tapping the
          // button re-enqueues it). The file is left as a .part for resume.
          debugPrint('download failed for ${t.id}: $e');
        } finally {
          _active.remove(t.id);
          await _save();
          notifyListeners();
        }
      }
    } finally {
      _working = false;
    }
  }

  /// Fetch the audio to a `.part` file, resuming via HTTP Range and retrying with
  /// backoff so a slow/unstable connection waits and resumes instead of failing.
  /// On success the `.part` is atomically renamed to the final path.
  Future<void> _fetchResilient(Track track) async {
    final finalPath = _pathFor(track.id);
    final part = File(_partPathFor(track.id));
    const maxAttempts = 8;
    var attempt = 0;
    var backoff = const Duration(seconds: 1);
    while (true) {
      attempt++;
      final client = http.Client();
      try {
        final existing = await part.exists() ? await part.length() : 0;
        http.Request mkReq() {
          final r = http.Request('GET', Uri.parse(api.streamUrl(track.id)));
          if (existing > 0) r.headers['range'] = 'bytes=$existing-';
          return r;
        }

        var resp = await client.send(mkReq()).timeout(const Duration(seconds: 30));
        // The stream URL carries the token in the query (no refresh interceptor),
        // so on 401 refresh the token and retry once.
        if (resp.statusCode == 401 && await api.ensureFreshToken()) {
          resp = await client.send(mkReq()).timeout(const Duration(seconds: 30));
        }
        if (resp.statusCode == 416) {
          // Range beyond EOF — the .part is already complete.
          await resp.stream.drain<void>();
        } else if (resp.statusCode == 200 || resp.statusCode == 206) {
          // 206 → append to the existing .part; 200 (server ignored Range) →
          // rewrite from scratch. Close the sink in finally so a mid-stream error
          // never leaks a handle (which on Windows would lock the file and block
          // the retry/rename).
          final append = resp.statusCode == 206 && existing > 0;
          final sink = part.openWrite(mode: append ? FileMode.append : FileMode.write);
          try {
            await sink.addStream(resp.stream);
          } finally {
            await sink.flush();
            await sink.close();
          }
        } else {
          throw ApiException('Download failed (HTTP ${resp.statusCode})');
        }
        // Success — promote .part to the final file.
        if (await File(finalPath).exists()) await File(finalPath).delete();
        if (await part.exists()) await part.rename(finalPath);
        return;
      } catch (e) {
        if (attempt >= maxAttempts) rethrow;
        // Wait, then retry — the partial file stays so we resume where we stopped.
        await Future.delayed(backoff);
        backoff = Duration(seconds: (backoff.inSeconds * 2).clamp(1, 30));
      } finally {
        client.close();
      }
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

  /// Save lyrics locally so they show in offline mode. Best-effort: a track
  /// without lyrics just leaves no file.
  Future<void> _fetchLyrics(Track track) async {
    try {
      final f = File(_lyricsPathFor(track.id));
      if (await f.exists()) return;
      final l = await api.lyrics(track.id);
      // Only persist if there's actual lyric content to show offline.
      if ((l.synced?.isNotEmpty ?? false) || (l.plain?.isNotEmpty ?? false)) {
        await f.writeAsString(jsonEncode(l.toJson()));
      }
    } catch (_) {}
  }

  /// Delete the audio + cover + lyrics + any partial if nothing references the
  /// track anymore, and drop it from the queue if pending.
  Future<void> _gc(String trackId) async {
    _dequeue(trackId);
    if ((_sources[trackId]?.isNotEmpty ?? false)) return;
    for (final p in [
      _pathFor(trackId),
      _partPathFor(trackId),
      _coverPathFor(trackId),
      _lyricsPathFor(trackId),
    ]) {
      final f = File(p);
      if (await f.exists()) await f.delete();
    }
    _downloaded.remove(trackId);
    _sources.remove(trackId);
    _meta.remove(trackId);
  }

  void _dequeue(String trackId) {
    if (_queuedIds.remove(trackId)) {
      _pending.removeWhere((t) => t.id == trackId);
    }
  }

  /// Remove `.part` files whose track is no longer referenced (interrupted, then
  /// the source was dropped) so they don't linger forever.
  Future<void> _sweepOrphanParts() async {
    try {
      final dir = _dir;
      if (dir == null) return;
      await for (final e in dir.list()) {
        if (e is File && e.path.endsWith('.audio.part')) {
          final name = e.uri.pathSegments.last; // stream_<id>.audio.part
          final id = name.substring('stream_'.length, name.length - '.audio.part'.length);
          if (!_sources.containsKey(id) || (_sources[id]?.isEmpty ?? true)) {
            try {
              await e.delete();
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  void _addSource(String trackId, String source) =>
      _sources.putIfAbsent(trackId, () => {}).add(source);

  // ---- Individual track download / remove ----
  Future<void> download(Track track) async {
    _addSource(track.id, manual);
    _meta[track.id] = track.toJson();
    await _save();
    _enqueue(track); // queued; the worker downloads it (resilient + resumable)
  }

  Future<void> remove(String trackId) async {
    _sources[trackId]?.remove(manual);
    await _gc(trackId);
    await _save();
    notifyListeners();
  }

  // ---- Whole-playlist (or Liked Songs) download toggle ----
  /// Queue every track for download (idempotent). Returns immediately; progress
  /// is reflected through [downloadedCount]/[anyPending] and notifyListeners.
  Future<void> downloadAll(List<Track> tracks, String source, {String? name}) async {
    for (final t in tracks) {
      _addSource(t.id, source);
      _meta[t.id] = t.toJson();
    }
    // Record the playlist so it can be browsed offline (snapshot of name + order).
    if (source != manual) {
      _playlists[source] = (name: name ?? source, ids: tracks.map((t) => t.id).toList());
    }
    await _save();
    for (final t in tracks) {
      _enqueue(t);
    }
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
