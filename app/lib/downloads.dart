import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'models.dart';
import 'settings.dart';

/// Thrown inside a download when the queue pauses (Wi-Fi only, on mobile data);
/// the partial file is kept and the track goes back to the head of the queue.
class _PausedForWifi implements Exception {}

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

  // Byte progress of the active download (for a per-track percentage).
  int _activeReceived = 0;
  int _activeTotal = 0;
  DateTime _lastProgressNotify = DateTime.fromMillisecondsSinceEpoch(0);

  // Wi-Fi only: true while the device is on a metered (mobile-data-only) link.
  bool _metered = false;
  StreamSubscription<List<ConnectivityResult>>? _connSub;

  DownloadManager(this.api);

  /// Downloads are held back right now (Wi-Fi only is on and we're on mobile data).
  bool get wifiBlocked => AppSettings.instance.downloadWifiOnly && _metered;

  /// Work is waiting because of the Wi-Fi only setting.
  bool get pausedForWifi => wifiBlocked && (_pending.isNotEmpty || _active.isNotEmpty);

  /// 0..1 for the track downloading right now (when its size is known), else null.
  double? progressOf(String id) {
    if (!_active.contains(id) || _activeTotal <= 0) return null;
    return (_activeReceived / _activeTotal).clamp(0.0, 1.0);
  }

  static bool _isMetered(List<ConnectivityResult> r) =>
      r.contains(ConnectivityResult.mobile) &&
      !r.contains(ConnectivityResult.wifi) &&
      !r.contains(ConnectivityResult.ethernet);

  void _onConnectivity(List<ConnectivityResult> r) {
    final was = wifiBlocked;
    _metered = _isMetered(r);
    if (was != wifiBlocked) notifyListeners();
    if (!wifiBlocked) _pump(); // back on Wi-Fi (or the setting is off): resume
  }

  void _onSettings() {
    // Turning Wi-Fi only off resumes a paused queue; turning it on pauses it at
    // the next chunk (the active download notices via [wifiBlocked]).
    if (!wifiBlocked) _pump();
    notifyListeners();
  }

  Future<void> _watchConnectivity() async {
    if (kIsWeb) return;
    AppSettings.instance.addListener(_onSettings);
    try {
      final c = Connectivity();
      _metered = _isMetered(await c.checkConnectivity());
      _connSub = c.onConnectivityChanged.listen(_onConnectivity);
    } catch (_) {
      _metered = false; // no connectivity info: never block
    }
  }

  @override
  void dispose() {
    _connSub?.cancel();
    AppSettings.instance.removeListener(_onSettings);
    super.dispose();
  }

  static const _kFiles = 'downloaded_tracks';
  static const _kSources = 'download_sources';
  static const _kMeta = 'download_meta';
  static const _kPlaylists = 'download_playlists';
  static const manual = 'manual';

  bool get supported => !kIsWeb;

  Future<void> init() async {
    if (!supported) return;
    await _watchConnectivity();
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
    // Songs downloaded before lyrics were saved alongside the audio have no
    // lyrics file, so they'd show none offline. Fill them in once we're online
    // (delayed so sign-in/token refresh has finished; failures retry next launch).
    unawaited(Future.delayed(const Duration(seconds: 8), backfillLyrics));
  }

  bool _backfilling = false;

  /// Fetch + save lyrics for every downloaded track that has no lyrics file yet.
  /// Sequential and best-effort: offline or failing requests are simply skipped.
  Future<void> backfillLyrics() async {
    if (!supported || _dir == null || _backfilling) return;
    _backfilling = true;
    try {
      for (final id in _downloaded.toList()) {
        if (File(_lyricsPathFor(id)).existsSync()) continue;
        try {
          saveLyrics(id, await api.lyrics(id));
        } catch (_) {
          return; // most likely offline / signed out — try again next launch
        }
      }
    } finally {
      _backfilling = false;
    }
  }

  /// Persist lyrics for a downloaded track so they're available offline. No-op
  /// for tracks that aren't downloaded or lyrics with no content.
  void saveLyrics(String id, Lyrics l) {
    if (!supported || _dir == null || !_downloaded.contains(id)) return;
    if (!((l.synced?.isNotEmpty ?? false) || (l.plain?.isNotEmpty ?? false))) return;
    try {
      File(_lyricsPathFor(id)).writeAsStringSync(jsonEncode(l.toJson()));
    } catch (_) {}
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
        // Wi-Fi only and on mobile data: leave the queue as is; a connectivity
        // change (or the setting being turned off) calls _pump again.
        if (wifiBlocked) break;
        final t = _pending.removeAt(0);
        _queuedIds.remove(t.id);
        if (_downloaded.contains(t.id)) continue;
        _active.add(t.id);
        _activeReceived = 0;
        _activeTotal = 0;
        notifyListeners();
        try {
          await _fetchResilient(t);
          // Removed (or "Remove all downloads") while it was in flight: drop it.
          if (!(_sources[t.id]?.isNotEmpty ?? false)) {
            await _gc(t.id);
            continue;
          }
          _downloaded.add(t.id);
          await _fetchCover(t); // best-effort cover for offline display
          await _fetchLyrics(t); // best-effort lyrics for offline display
        } on _PausedForWifi {
          // Back to the head of the queue; the .part resumes later.
          if (_sources[t.id]?.isNotEmpty ?? false) {
            _pending.insert(0, t);
            _queuedIds.add(t.id);
          }
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
          _activeReceived = append ? existing : 0;
          final len = resp.contentLength ?? 0;
          _activeTotal = len > 0 ? _activeReceived + len : 0;
          final sink = part.openWrite(mode: append ? FileMode.append : FileMode.write);
          try {
            await for (final chunk in resp.stream) {
              sink.add(chunk);
              _activeReceived += chunk.length;
              if (wifiBlocked) throw _PausedForWifi();
              // Throttled: every row watching downloads rebuilds on notify.
              final now = DateTime.now();
              if (now.difference(_lastProgressNotify).inMilliseconds > 400) {
                _lastProgressNotify = now;
                notifyListeners();
              }
            }
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
      } on _PausedForWifi {
        rethrow; // not a failure: no retry, the .part stays for resume
      } catch (e) {
        if (attempt >= maxAttempts) rethrow;
        if (wifiBlocked) throw _PausedForWifi();
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

  /// Our files in the documents directory (audio, partials, covers, lyrics).
  Stream<File> _ownFiles() async* {
    final dir = _dir;
    if (dir == null) return;
    await for (final e in dir.list()) {
      if (e is File && e.uri.pathSegments.last.startsWith('stream_')) yield e;
    }
  }

  /// Total bytes used by downloads (audio + covers + lyrics + partial files).
  Future<int> storageBytes() async {
    if (!supported) return 0;
    var total = 0;
    try {
      await for (final f in _ownFiles()) {
        try {
          total += await f.length();
        } catch (_) {}
      }
    } catch (_) {}
    return total;
  }

  /// Delete every download (and anything queued), including offline playlists.
  Future<void> removeEverything() async {
    if (!supported) return;
    _pending.clear();
    _queuedIds.clear();
    _sources.clear();
    _playlists.clear();
    _meta.clear();
    _downloaded.clear();
    try {
      await for (final f in _ownFiles()) {
        // The active download's .part may be open; it's swept on next launch.
        try {
          await f.delete();
        } catch (_) {}
      }
    } catch (_) {}
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
