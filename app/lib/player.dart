import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'auto_browse.dart';
import 'downloads.dart';
import 'models.dart';

/// Wraps a just_audio [AudioPlayer]: queue, playback state, lyrics, resume-on-
/// reopen persistence, and a stall watchdog that auto-recovers if a stream
/// silently stops (mitigates the mid-track cutout some networks/proxies cause).
class PlayerModel extends ChangeNotifier {
  final Api api;
  final DownloadManager downloads;
  final AudioPlayer _player = AudioPlayer();

  List<Track> _queue = [];
  ConcatenatingAudioSource? _source; // kept so we can add/insert into the queue
  int _index = 0;
  bool _scrobbled = false;
  Lyrics? _lyrics;
  Timer? _watchdog;
  Timer? _saveTimer;
  Timer? _heartbeat;
  Duration _lastPos = Duration.zero;
  int _frozenTicks = 0;
  bool _recovering = false;

  // ---- Listen along ----
  String? listenHostId;
  String? listenHostName;
  Timer? _listenTimer;
  List<Track> _savedQueue = [];
  int _savedIndex = 0;
  bool _restoreAfterCurrent = false;

  // ---- Chorus (collaborative synced listening) ----
  ChorusState? chorus;
  Timer? _chorusTimer;
  bool _applyingChorus = false; // guard: don't broadcast while adopting shared state
  bool get inChorus => chorus != null;

  static const _kSession = 'last_session';

  PlayerModel(this.api, this.downloads) {
    _player.currentIndexStream.listen((i) {
      if (i != null && i != _index) {
        _index = i;
        _scrobbled = false;
        _loadLyrics();
        _postActivity();
        // In a chorus, the host must push natural track advances (song ended →
        // next track) so the shared state doesn't lag and revert everyone.
        if (inChorus && (chorus?.isHost ?? false) && !_applyingChorus) _broadcastChorus();
        notifyListeners();
      }
    });
    _player.playerStateStream.listen((_) {
      _saveSession();
      _postActivity();
      notifyListeners();
    });
    // When a listen-along session is stopped, finish the current song then return
    // to the user's own queue.
    _player.processingStateStream.listen((st) {
      if (st == ProcessingState.completed && _restoreAfterCurrent) {
        _restoreAfterCurrent = false;
        if (_savedQueue.isNotEmpty) playQueue(_savedQueue, start: _savedIndex);
      }
    });
    _player.positionStream.listen((pos) {
      if (!_scrobbled && pos.inSeconds >= 5 && current != null) {
        _scrobbled = true;
        api.scrobble(current!.id).catchError((_) {});
      }
      notifyListeners();
    });
    // Surface playback errors (codec/network/auth) instead of silently failing.
    _player.playbackEventStream.listen(
      (_) {},
      onError: (Object e, StackTrace st) => debugPrint('player playback error: $e'),
    );
    // Stall watchdog: if we're "playing" but the position hasn't advanced and
    // we're not legitimately buffering, the stream likely dropped — reload it.
    _watchdog = Timer.periodic(const Duration(seconds: 4), (_) => _checkStall());
    // Persist position periodically so "resume where you left off" is accurate.
    _saveTimer = Timer.periodic(const Duration(seconds: 5), (_) => _saveSession());
    // Broadcast presence (for the friends panel) periodically.
    _heartbeat = Timer.periodic(const Duration(seconds: 12), (_) => _postActivity());
    // Android Auto / media-browser: expose a browsable library + handle taps.
    if (!kIsWeb && Platform.isAndroid) {
      final browse = AutoBrowse(api);
      registerMediaBrowsing(
        getChildren: browse.getChildren,
        getMediaItem: browse.getMediaItem,
        playFromMediaId: playFromMediaId,
        search: browse.searchItems,
      );
    }
  }

  /// Play an item chosen from a media browser (e.g. Android Auto): loads the
  /// whole context list and starts at the tapped track.
  Future<void> playFromMediaId(String mediaId) async {
    final browse = AutoBrowse(api);
    final res = await browse.resolvePlay(mediaId);
    if (res == null) return;
    await playQueue(res.tracks, start: res.index);
  }

  void _postActivity() {
    api
        .postActivity(
          trackId: current?.id,
          positionMs: _player.position.inMilliseconds,
          playing: _player.playing,
        )
        .catchError((_) {});
  }

  bool get listeningAlong => listenHostId != null;

  AudioPlayer get raw => _player;
  List<Track> get queue => _queue;
  int get index => _index;
  Track? get current => (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  bool get playing => _player.playing;
  Duration get position => _player.position;
  // Fall back to the track's known metadata length until the audio source loads
  // its own duration. Otherwise a restored (paused, not-yet-loaded) session shows
  // duration 0:00, so the progress bar reads 0 while the position is non-zero and
  // then jumps on play.
  Duration get duration {
    final d = _player.duration;
    if (d != null && d > Duration.zero) return d;
    final t = current;
    return t != null ? Duration(milliseconds: (t.duration * 1000).round()) : Duration.zero;
  }
  Lyrics? get lyrics => _lyrics;

  AudioSource _sourceFor(Track t) {
    final local = downloads.localPath(t.id);
    final uri = local != null ? Uri.file(local) : Uri.parse(api.streamUrl(t.id));
    return AudioSource.uri(
      uri,
      tag: MediaItem(
        id: t.id,
        title: t.title,
        artist: t.artistName,
        album: t.albumTitle,
        artUri: Uri.parse(api.trackCoverUrl(t.id)),
      ),
    );
  }

  Future<void> playQueue(List<Track> tracks, {int start = 0}) async {
    if (tracks.isEmpty) return;
    // Manually choosing music exits any listen-along session.
    if (listenHostId != null) {
      _listenTimer?.cancel();
      _listenTimer = null;
      listenHostId = null;
      listenHostName = null;
    }
    _restoreAfterCurrent = false;
    _queue = List.of(tracks);
    _index = start;
    _scrobbled = false;
    _loadLyrics();
    notifyListeners();
    try {
      _source = ConcatenatingAudioSource(children: tracks.map(_sourceFor).toList());
      await _player.setAudioSource(_source!, initialIndex: start);
      await _player.play();
      _saveSession();
      _broadcastChorus();
    } catch (e) {
      debugPrint('play error: $e');
    }
  }

  /// Append a track to the end of the queue (starts playback if idle).
  Future<void> addToQueue(Track t) async {
    if (_source == null || _queue.isEmpty) return playQueue([t]);
    _queue.add(t);
    await _source!.add(_sourceFor(t));
    notifyListeners();
    _broadcastChorus();
  }

  /// Insert a track right after the current one.
  Future<void> playNext(Track t) async {
    if (_source == null || _queue.isEmpty) return playQueue([t]);
    final at = (_index + 1).clamp(0, _queue.length);
    _queue.insert(at, t);
    await _source!.insert(at, _sourceFor(t));
    notifyListeners();
    _broadcastChorus();
  }

  /// Remove an upcoming track from the queue (not the current one).
  Future<void> removeFromQueue(int index) async {
    if (_source == null || index <= _index || index >= _queue.length) return;
    _queue.removeAt(index);
    await _source!.removeAt(index);
    notifyListeners();
    _broadcastChorus();
  }

  /// Jump to a specific track in the queue.
  Future<void> playAt(int index) async {
    if (index < 0 || index >= _queue.length) return;
    await _player.seek(Duration.zero, index: index);
    await _player.play();
    _broadcastChorus();
  }

  // ---- Listen along ----
  Future<void> startListenAlong(String hostId, String hostName) async {
    _savedQueue = List.of(_queue);
    _savedIndex = _index;
    listenHostId = hostId;
    listenHostName = hostName;
    _restoreAfterCurrent = false;
    await _player.setLoopMode(LoopMode.off);
    notifyListeners();
    await _syncToHost();
    _listenTimer?.cancel();
    _listenTimer = Timer.periodic(const Duration(seconds: 3), (_) => _syncToHost());
  }

  Future<void> _syncToHost() async {
    final hostId = listenHostId;
    if (hostId == null) return;
    HostActivity a;
    try {
      a = await api.userActivity(hostId);
    } catch (_) {
      return;
    }
    if (listenHostId != hostId) return;
    // Host went offline — leave the session, finish the current song, then
    // return to our own queue (same as a manual Stop).
    if (!a.online) {
      stopListenAlong();
      return;
    }
    if (a.track == null) return;
    final drift = (a.playing && a.updatedAt != null)
        ? DateTime.now().millisecondsSinceEpoch - a.updatedAt!
        : 0;
    var targetMs = a.positionMs + (a.playing ? drift : 0);
    if (targetMs < 0) targetMs = 0;
    if (current?.id != a.track!.id) {
      // Host moved to a new track — follow it.
      _queue = [a.track!];
      _index = 0;
      _scrobbled = false;
      _loadLyrics();
      notifyListeners();
      try {
        _source = ConcatenatingAudioSource(children: [_sourceFor(a.track!)]);
        await _player.setAudioSource(_source!, initialPosition: Duration(milliseconds: targetMs));
        await _player.play();
      } catch (e) {
        debugPrint('listen-along load error: $e');
      }
    } else {
      // Same track — keep position + play state in sync.
      if ((_player.position.inMilliseconds - targetMs).abs() > 2500) {
        await _player.seek(Duration(milliseconds: targetMs));
      }
      if (a.playing && !_player.playing) await _player.play();
      if (!a.playing && _player.playing) await _player.pause();
    }
  }

  void stopListenAlong() {
    _listenTimer?.cancel();
    _listenTimer = null;
    listenHostId = null;
    listenHostName = null;
    // Finish the current song, then return to the user's own queue.
    _restoreAfterCurrent = _savedQueue.isNotEmpty;
    notifyListeners();
  }

  // ---- Chorus (collaborative synced listening) ----
  void _ensureChorusPolling() {
    _chorusTimer ??= Timer.periodic(const Duration(seconds: 2), (_) => _chorusSync());
  }

  void _stopChorusPolling() {
    _chorusTimer?.cancel();
    _chorusTimer = null;
  }

  /// Push our local playback (queue/index/position/playing) to the shared chorus.
  void _broadcastChorus() {
    if (chorus == null || _applyingChorus) return;
    api
        .postChorusState(
          _queue.map((t) => t.id).toList(),
          _index,
          _player.position.inMilliseconds,
          _player.playing,
        )
        .catchError((_) {});
  }

  bool _idsEqual(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  /// Start hosting a chorus from the current queue.
  Future<void> startChorus(String mode) async {
    if (_queue.isEmpty) return;
    try {
      chorus = await api.startChorus(
        mode,
        _queue.map((t) => t.id).toList(),
        _index,
        _player.position.inMilliseconds,
        _player.playing,
      );
      notifyListeners();
      _ensureChorusPolling();
    } catch (e) {
      debugPrint('startChorus error: $e');
    }
  }

  Future<void> setChorusMode(String mode) async {
    await api.setChorusMode(mode).catchError((_) {});
    if (chorus != null) {
      // optimistic; the next poll confirms
      await _chorusSync();
    }
  }

  /// Begin following a chorus after joining/requesting (kicks off polling).
  void joinedChorus() {
    _ensureChorusPolling();
    _chorusSync();
  }

  /// Force an immediate chorus poll (e.g. after approving/removing a member).
  Future<void> refreshChorus() => _chorusSync();

  Future<void> leaveChorusSession() async {
    await api.leaveChorus().catchError((_) {});
    chorus = null;
    _stopChorusPolling();
    notifyListeners();
  }

  /// Poll the shared chorus state and reconcile local playback with it.
  Future<void> _chorusSync() async {
    ChorusState? c;
    try {
      c = await api.chorus();
    } catch (_) {
      return; // transient — keep current state
    }
    if (c == null) {
      if (chorus != null) {
        chorus = null;
        _stopChorusPolling();
        notifyListeners();
      }
      return;
    }
    chorus = c;
    notifyListeners();
    if (c.queueIds.isEmpty) return;

    final localIds = _queue.map((t) => t.id).toList();
    final sigMatch = _idsEqual(localIds, c.queueIds) && _index == c.index;
    final sharedTrackId =
        (c.index >= 0 && c.index < c.queueIds.length) ? c.queueIds[c.index] : null;
    final drift = c.playing ? (DateTime.now().millisecondsSinceEpoch - c.updatedAt) : 0;
    var targetMs = c.positionMs + (drift > 0 ? drift : 0);
    if (targetMs < 0) targetMs = 0;

    if (!sigMatch) {
      // If we're the host and the shared state still reflects our own last update,
      // our local state is newer (e.g. the track just auto-advanced) — push it
      // instead of reverting to the stale shared index.
      if (c.isHost && c.controllerId == c.hostId) {
        _broadcastChorus();
        return;
      }
      // Adopt the shared queue/index. Keep the current track's position when it's
      // unchanged; otherwise jump to the shared (extrapolated) position.
      final sameTrack = current?.id == sharedTrackId;
      final pos = sameTrack ? _player.position : Duration(milliseconds: targetMs);
      _applyingChorus = true;
      try {
        _queue = List.of(c.queue);
        _index = c.index;
        _scrobbled = false;
        _loadLyrics();
        _source = ConcatenatingAudioSource(children: c.queue.map(_sourceFor).toList());
        await _player.setAudioSource(_source!, initialIndex: c.index, initialPosition: pos);
        if (c.playing) {
          await _player.play();
        } else {
          await _player.pause();
        }
      } catch (e) {
        debugPrint('chorus adopt error: $e');
      } finally {
        _applyingChorus = false;
      }
      notifyListeners();
      return;
    }

    // Content matches the shared state.
    if (c.isHost) {
      _broadcastChorus(); // host drives the shared timeline
    } else {
      if ((_player.position.inMilliseconds - targetMs).abs() > 3000) {
        await _player.seek(Duration(milliseconds: targetMs));
      }
      if (c.playing && !_player.playing) await _player.play();
      if (!c.playing && _player.playing) await _player.pause();
    }
  }

  Future<void> toggle() async {
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
    _broadcastChorus();
  }

  // Manual next/previous wrap around the ends so a playlist always loops.
  Future<void> next() async {
    if (_player.hasNext) {
      await _player.seekToNext();
    } else {
      await _player.seek(Duration.zero, index: 0); // wrap to first
    }
    _broadcastChorus();
  }

  Future<void> previous() async {
    if (_player.position.inSeconds > 3) {
      await _player.seek(Duration.zero);
    } else if (_player.hasPrevious) {
      await _player.seekToPrevious();
    } else {
      final last = _queue.isEmpty ? 0 : _queue.length - 1;
      await _player.seek(Duration.zero, index: last); // wrap to last
    }
    _broadcastChorus();
  }

  Future<void> seek(Duration d) async {
    await _player.seek(d);
    _broadcastChorus();
  }
  Future<void> setVolume(double v) async {
    await _player.setVolume(v);
    notifyListeners(); // update the slider immediately, even while paused
  }
  double get volume => _player.volume;

  // ---- Repeat (off / all / one) + shuffle ----
  LoopMode get loopMode => _player.loopMode;
  bool get shuffleEnabled => _player.shuffleModeEnabled;

  Future<void> cycleRepeat() async {
    const order = [LoopMode.off, LoopMode.all, LoopMode.one];
    final next = order[(order.indexOf(_player.loopMode) + 1) % order.length];
    await _player.setLoopMode(next);
    notifyListeners();
  }

  Future<void> toggleShuffle() async {
    final enable = !_player.shuffleModeEnabled;
    if (enable) await _player.shuffle(); // generate a fresh shuffle order
    await _player.setShuffleModeEnabled(enable);
    notifyListeners();
  }

  // ---- Lyrics ----
  Future<void> _loadLyrics() async {
    _lyrics = null;
    notifyListeners();
    final t = current;
    if (t == null) return;
    try {
      final l = await api.lyrics(t.id);
      if (current?.id == t.id) {
        _lyrics = l;
        notifyListeners();
      }
    } catch (_) {}
  }

  // ---- Stall recovery (cutout mitigation) ----
  void _checkStall() {
    final t = current;
    if (t == null || _recovering) return;
    final st = _player.processingState;
    final isStreaming = downloads.localPath(t.id) == null;
    if (_player.playing && isStreaming && st == ProcessingState.ready) {
      if (_player.position == _lastPos) {
        _frozenTicks++;
        if (_frozenTicks >= 2) _recoverStream();
      } else {
        _frozenTicks = 0;
      }
    } else {
      _frozenTicks = 0;
    }
    _lastPos = _player.position;
  }

  Future<void> _recoverStream() async {
    if (_recovering || _queue.isEmpty) return;
    _recovering = true;
    _frozenTicks = 0;
    final at = _player.position;
    final idx = _index;
    debugPrint('player: stream stalled — recovering at $at');
    try {
      _source = ConcatenatingAudioSource(children: _queue.map(_sourceFor).toList());
      await _player.setAudioSource(_source!, initialIndex: idx, initialPosition: at);
      await _player.play();
    } catch (e) {
      debugPrint('recover failed: $e');
    } finally {
      _recovering = false;
    }
  }

  // ---- Resume persistence ----
  Future<void> _saveSession() async {
    if (_queue.isEmpty) return;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(
        _kSession,
        jsonEncode({
          'queue': _queue.map((t) => t.toJson()).toList(),
          'index': _index,
          'position': _player.position.inMilliseconds,
        }),
      );
    } catch (_) {}
  }

  /// Restore the last session paused at its saved position (call on startup).
  Future<void> restoreSession() async {
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_kSession);
      if (raw == null) return;
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final tracks = (data['queue'] as List).map((e) => Track.fromJson(e)).toList();
      if (tracks.isEmpty) return;
      _queue = tracks;
      _index = (data['index'] as int?) ?? 0;
      if (_index < 0 || _index >= _queue.length) _index = 0;
      final posMs = (data['position'] as int?) ?? 0;
      _loadLyrics();
      notifyListeners();
      _source = ConcatenatingAudioSource(children: _queue.map(_sourceFor).toList());
      await _player.setAudioSource(
        _source!,
        initialIndex: _index,
        initialPosition: Duration(milliseconds: posMs),
        preload: false,
      );
      // Do NOT auto-play — leave it paused so the user can resume.
    } catch (e) {
      debugPrint('restore failed: $e');
    }
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    _saveTimer?.cancel();
    _heartbeat?.cancel();
    _listenTimer?.cancel();
    _chorusTimer?.cancel();
    _player.dispose();
    super.dispose();
  }
}
