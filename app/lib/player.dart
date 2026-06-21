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
  String? _lyricsForId; // track whose lyrics are currently loaded
  Timer? _watchdog;
  Timer? _saveTimer;
  Timer? _heartbeat;
  Timer? _chorusTick; // host: periodic truth broadcast so members never drift
  Duration _lastPos = Duration.zero;
  int _frozenTicks = 0;
  bool _recovering = false;

  // ---- Listen along ----
  // The follower plays the host's music on THEIR OWN device, kept in sync.
  String? listenHostId;
  String? listenHostName;
  bool _listenLooping = false;
  int _listenVersion = 0;
  List<Track> _savedQueue = [];
  int _savedIndex = 0;
  bool _restoreAfterCurrent = false;

  // ---- Chorus (collaborative listening) ----
  // Audio plays ONLY on the host's device. Members are remote controls: their
  // local player stays silent and their UI mirrors the host's playback
  // (extrapolated from positionMs/serverNow). Only the host writes the
  // authoritative state; members enqueue commands the host applies + re-broadcasts.
  ChorusState? chorus;
  bool _chorusLooping = false; // long-poll loop running
  int _chorusVersion = 0; // long-poll cursor
  bool _applyingChorus = false; // guard while the host applies remote commands
  bool _chorusAutoStop = false; // user stopped — don't auto-restart until next play
  bool _lastHostPlaying = false; // last broadcast play state (host)
  // Member-side position extrapolation (no local audio to read from).
  int _memberPosBaseMs = 0;
  int _memberPosBaseAt = 0;
  Timer? _memberTicker;

  bool get inChorus => chorus != null;
  bool get isChorusHost => chorus?.isHost ?? false;
  // An *approved* member acting as a silent remote (pending requests don't count).
  bool get isChorusMember => chorus != null && !chorus!.isHost && !chorus!.isPending;

  static const _kSession = 'last_session';

  PlayerModel(this.api, this.downloads) {
    _player.currentIndexStream.listen((i) {
      if (i != null && i != _index) {
        _index = i;
        _scrobbled = false;
        _loadLyrics();
        _postActivity();
        // Host: push natural track advances (song ended → next) so members follow.
        if (isChorusHost && !_applyingChorus) _broadcastChorus();
        notifyListeners();
      }
    });
    _player.playerStateStream.listen((st) {
      _saveSession();
      _postActivity();
      // Host: broadcast play/pause transitions (covers OS / lock-screen controls).
      if (isChorusHost && !_applyingChorus && st.playing != _lastHostPlaying) {
        _lastHostPlaying = st.playing;
        _broadcastChorus();
      }
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
    // Host: low-frequency truth broadcast so members re-base position (no drift),
    // on top of the instant broadcasts on every control event.
    _chorusTick = Timer.periodic(const Duration(seconds: 5), (_) {
      if (isChorusHost && !_applyingChorus) _broadcastChorus();
    });
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
          positionMs: position.inMilliseconds,
          playing: playing,
        )
        .catchError((_) {});
  }

  bool get listeningAlong => listenHostId != null;

  AudioPlayer get raw => _player;

  // Public playback view. For a silent chorus member these reflect the SHARED
  // (host) state so the UI shows the right song + a moving progress bar.
  List<Track> get queue => isChorusMember ? chorus!.queue : _queue;
  int get index => isChorusMember ? chorus!.index : _index;
  Track? get current {
    if (isChorusMember) {
      final q = chorus!.queue;
      final i = chorus!.index;
      return (i >= 0 && i < q.length) ? q[i] : null;
    }
    return (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  }

  bool get playing => isChorusMember ? chorus!.playing : _player.playing;
  Duration get position =>
      isChorusMember ? Duration(milliseconds: _memberPositionMs()) : _player.position;
  // Fall back to the track's known metadata length until the audio source loads
  // its own duration (so a restored, not-yet-loaded session doesn't read 0:00).
  Duration get duration {
    if (isChorusMember) {
      final t = current;
      return t != null ? Duration(milliseconds: (t.duration * 1000).round()) : Duration.zero;
    }
    final d = _player.duration;
    if (d != null && d > Duration.zero) return d;
    final t = current;
    return t != null ? Duration(milliseconds: (t.duration * 1000).round()) : Duration.zero;
  }

  Lyrics? get lyrics => _lyrics;

  /// A silent member's extrapolated position (their device has no audio engine).
  int _memberPositionMs() {
    if (chorus == null) return 0;
    var ms = _memberPosBaseMs;
    if (chorus!.playing) ms += DateTime.now().millisecondsSinceEpoch - _memberPosBaseAt;
    final durMs = ((current?.duration ?? 0) * 1000).round();
    if (durMs > 0 && ms > durMs) ms = durMs;
    return ms < 0 ? 0 : ms;
  }

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
    // A silent chorus member: changing the song is a remote command to the host.
    if (isChorusMember) {
      _sendCommand(
        queue: tracks.map((t) => t.id).toList(),
        index: start,
        positionMs: 0,
        playing: true,
      );
      return;
    }
    // Manually choosing music exits any listen-along session.
    if (listenHostId != null) {
      _listenLooping = false;
      listenHostId = null;
      listenHostName = null;
    }
    _restoreAfterCurrent = false;
    _chorusAutoStop = false; // a fresh play re-enables auto-start
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
      if (isChorusHost) {
        _broadcastChorus();
      } else {
        _maybeAutoStartChorus();
      }
    } catch (e) {
      debugPrint('play error: $e');
    }
  }

  /// Append a track to the end of the queue (starts playback if idle).
  Future<void> addToQueue(Track t) async {
    if (isChorusMember) {
      _sendCommand(queue: [...chorus!.queueIds, t.id], index: chorus!.index);
      return;
    }
    if (_source == null || _queue.isEmpty) return playQueue([t]);
    _queue.add(t);
    await _source!.add(_sourceFor(t));
    notifyListeners();
    _broadcastChorus();
  }

  /// Insert a track right after the current one.
  Future<void> playNext(Track t) async {
    if (isChorusMember) {
      final ids = [...chorus!.queueIds];
      final at = (chorus!.index + 1).clamp(0, ids.length);
      ids.insert(at, t.id);
      _sendCommand(queue: ids, index: chorus!.index);
      return;
    }
    if (_source == null || _queue.isEmpty) return playQueue([t]);
    final at = (_index + 1).clamp(0, _queue.length);
    _queue.insert(at, t);
    await _source!.insert(at, _sourceFor(t));
    notifyListeners();
    _broadcastChorus();
  }

  /// Remove an upcoming track from the queue (not the current one).
  Future<void> removeFromQueue(int index) async {
    if (isChorusMember) {
      if (index <= chorus!.index || index >= chorus!.queueIds.length) return;
      final ids = [...chorus!.queueIds]..removeAt(index);
      _sendCommand(queue: ids, index: chorus!.index);
      return;
    }
    if (_source == null || index <= _index || index >= _queue.length) return;
    _queue.removeAt(index);
    await _source!.removeAt(index);
    notifyListeners();
    _broadcastChorus();
  }

  /// Jump to a specific track in the queue.
  Future<void> playAt(int index) async {
    if (isChorusMember) {
      if (index < 0 || index >= chorus!.queueIds.length) return;
      _sendCommand(index: index, positionMs: 0, playing: true);
      return;
    }
    if (index < 0 || index >= _queue.length) return;
    await _player.seek(Duration.zero, index: index);
    await _player.play();
    _broadcastChorus();
  }

  // ---- Listen along ----
  Future<void> startListenAlong(String hostId, String hostName) async {
    // Listen-along is a personal follow — if we were hosting a chorus, end it.
    if (isChorusHost) await leaveChorusSession();
    _savedQueue = List.of(_queue);
    _savedIndex = _index;
    listenHostId = hostId;
    listenHostName = hostName;
    _restoreAfterCurrent = false;
    _listenVersion = 0;
    await _player.setLoopMode(LoopMode.off);
    notifyListeners();
    _listenLooping = true;
    _listenLoop();
  }

  /// Long-poll the host's activity and keep our playback in lock-step.
  Future<void> _listenLoop() async {
    while (_listenLooping && listenHostId != null) {
      final hostId = listenHostId!;
      HostActivity a;
      try {
        a = await api.userActivityPoll(hostId, _listenVersion);
      } catch (_) {
        await Future.delayed(const Duration(seconds: 1));
        continue;
      }
      if (!_listenLooping || listenHostId != hostId) break;
      _listenVersion = a.version;
      await _applyHostActivity(a);
    }
  }

  Future<void> _applyHostActivity(HostActivity a) async {
    if (listenHostId == null) return;
    if (!a.online) {
      stopListenAlong();
      return;
    }
    if (a.track == null) return;
    // Extrapolate to "now" using server clocks (skew-free), then to local now.
    final advance = (a.playing && a.serverNow > 0 && a.updatedAt != null)
        ? a.serverNow - a.updatedAt!
        : 0;
    var targetMs = a.positionMs + (advance > 0 ? advance : 0);
    if (targetMs < 0) targetMs = 0;
    if (current?.id != a.track!.id) {
      _queue = [a.track!];
      _index = 0;
      _scrobbled = false;
      _loadLyrics();
      notifyListeners();
      try {
        _source = ConcatenatingAudioSource(children: [_sourceFor(a.track!)]);
        await _player.setAudioSource(_source!, initialPosition: Duration(milliseconds: targetMs));
        if (a.playing) {
          await _player.play();
        } else {
          await _player.pause();
        }
      } catch (e) {
        debugPrint('listen-along load error: $e');
      }
    } else {
      if ((_player.position.inMilliseconds - targetMs).abs() > 2000) {
        await _player.seek(Duration(milliseconds: targetMs));
      }
      if (a.playing && !_player.playing) await _player.play();
      if (!a.playing && _player.playing) await _player.pause();
    }
  }

  void stopListenAlong() {
    _listenLooping = false;
    listenHostId = null;
    listenHostName = null;
    // Finish the current song, then return to the user's own queue.
    _restoreAfterCurrent = _savedQueue.isNotEmpty;
    notifyListeners();
  }

  // ---- Chorus ----
  void _maybeAutoStartChorus() {
    if (chorus != null || _chorusAutoStop || _queue.isEmpty) return;
    startChorus('open'); // auto-host an open chorus whenever playback starts
  }

  void _startChorusLoop() {
    if (_chorusLooping) return;
    _chorusLooping = true;
    _chorusLoop();
  }

  void _stopChorusLoop() {
    _chorusLooping = false;
  }

  /// Long-poll the shared chorus; reconcile as host (apply commands + broadcast)
  /// or as a silent member (mirror the state).
  Future<void> _chorusLoop() async {
    while (_chorusLooping) {
      ChorusState? c;
      try {
        c = await api.chorusPoll(_chorusVersion);
      } catch (_) {
        await Future.delayed(const Duration(seconds: 1));
        continue;
      }
      if (!_chorusLooping) break;
      if (c == null) {
        _onChorusEnded();
        break;
      }
      _chorusVersion = c.version;
      await _applyChorusUpdate(c);
    }
  }

  void _onChorusEnded() {
    final wasMember = isChorusMember;
    chorus = null;
    _chorusLooping = false;
    _stopMemberTicker();
    if (wasMember) _player.pause();
    notifyListeners();
  }

  Future<void> _applyChorusUpdate(ChorusState c) async {
    final wasMember = isChorusMember;
    chorus = c;
    if (c.isHost) {
      _stopMemberTicker();
      if (c.commands.isNotEmpty) await _applyHostCommands(c.commands, c);
      notifyListeners();
    } else if (c.isPending) {
      // Awaiting approval — keep our own music; just reflect the pending state.
      _stopMemberTicker();
      notifyListeners();
    } else {
      // Approved member — silent remote mirroring the host.
      if (!wasMember) await _player.pause();
      _setMemberBase(c);
      _ensureMemberTicker();
      // Load lyrics for the shared current track when it changes.
      final t = current;
      if (t != null && t.id != _lyricsForId) _loadLyrics();
      notifyListeners();
    }
  }

  void _setMemberBase(ChorusState c) {
    final advance = (c.playing && c.serverNow > 0) ? (c.serverNow - c.updatedAt) : 0;
    _memberPosBaseMs = c.positionMs + (advance > 0 ? advance : 0);
    _memberPosBaseAt = DateTime.now().millisecondsSinceEpoch;
  }

  void _ensureMemberTicker() {
    _memberTicker ??= Timer.periodic(const Duration(milliseconds: 300), (_) {
      if (isChorusMember && chorus!.playing) notifyListeners();
    });
  }

  void _stopMemberTicker() {
    _memberTicker?.cancel();
    _memberTicker = null;
  }

  /// Host: apply queued member commands to the real player, then broadcast truth.
  Future<void> _applyHostCommands(List<ChorusPatch> cmds, ChorusState c) async {
    // Merge: last defined value per field wins across the batch.
    List<String>? tQueue;
    int? tIndex;
    int? tPos;
    bool? tPlaying;
    for (final p in cmds) {
      if (p.queue != null) tQueue = p.queue;
      if (p.index != null) tIndex = p.index;
      if (p.positionMs != null) tPos = p.positionMs;
      if (p.playing != null) tPlaying = p.playing;
    }
    _applyingChorus = true;
    try {
      final localIds = _queue.map((t) => t.id).toList();
      if (tQueue != null && !_idsEqual(tQueue, localIds)) {
        final resolved = await _resolveTracks(tQueue, c);
        if (resolved.isNotEmpty) {
          _queue = resolved;
          _index = (tIndex ?? 0).clamp(0, _queue.length - 1);
          _scrobbled = false;
          _loadLyrics();
          _source = ConcatenatingAudioSource(children: _queue.map(_sourceFor).toList());
          await _player.setAudioSource(_source!,
              initialIndex: _index, initialPosition: Duration(milliseconds: tPos ?? 0));
        }
      } else {
        if (tIndex != null && tIndex != _index && tIndex >= 0 && tIndex < _queue.length) {
          await _player.seek(Duration(milliseconds: tPos ?? 0), index: tIndex);
        } else if (tPos != null) {
          await _player.seek(Duration(milliseconds: tPos));
        }
      }
      if (tPlaying != null) {
        if (tPlaying && !_player.playing) await _player.play();
        if (!tPlaying && _player.playing) await _player.pause();
        _lastHostPlaying = tPlaying;
      }
    } catch (e) {
      debugPrint('chorus apply command error: $e');
    } finally {
      _applyingChorus = false;
    }
    _broadcastChorus();
  }

  /// Resolve track ids to Track objects: from the current queue or the hydrated
  /// chorus queue first, then fetch any still-missing ids from the server.
  Future<List<Track>> _resolveTracks(List<String> ids, ChorusState c) async {
    final pool = <String, Track>{};
    for (final t in _queue) {
      pool[t.id] = t;
    }
    for (final t in c.queue) {
      pool[t.id] = t;
    }
    final missing = ids.where((id) => !pool.containsKey(id)).toSet().toList();
    if (missing.isNotEmpty) {
      try {
        final fetched = await api.tracksByIds(missing);
        for (final t in fetched) {
          pool[t.id] = t;
        }
      } catch (_) {}
    }
    return ids.map((id) => pool[id]).whereType<Track>().toList();
  }

  /// Host: publish our real playback as the chorus's source of truth.
  void _broadcastChorus() {
    if (!isChorusHost || _applyingChorus) return;
    api
        .postChorusState(
          _queue.map((t) => t.id).toList(),
          _index,
          _player.position.inMilliseconds,
          _player.playing,
        )
        .catchError((_) {});
  }

  /// Member: ask the host to change playback.
  void _sendCommand({List<String>? queue, int? index, int? positionMs, bool? playing}) {
    if (!isChorusMember) return;
    api
        .sendChorusCommand(queue: queue, index: index, positionMs: positionMs, playing: playing)
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
    _chorusAutoStop = false;
    try {
      final c = await api.startChorus(
        mode,
        _queue.map((t) => t.id).toList(),
        _index,
        _player.position.inMilliseconds,
        _player.playing,
      );
      chorus = c;
      _chorusVersion = c.version;
      _lastHostPlaying = _player.playing;
      notifyListeners();
      _startChorusLoop();
    } catch (e) {
      debugPrint('startChorus error: $e');
    }
  }

  Future<void> setChorusMode(String mode) async {
    // The mode change bumps the server version; the long-poll picks it up.
    await api.setChorusMode(mode).catchError((_) {});
  }

  /// Begin following a chorus after joining/requesting (kicks off the long-poll).
  void joinedChorus() {
    _chorusVersion = 0; // force an immediate hydrate on the first poll
    _startChorusLoop();
  }

  /// Host actions (approve/deny/remove) bump the server version on their own, so
  /// the long-poll refreshes automatically — nothing to force here.
  Future<void> refreshChorus() async {}

  Future<void> leaveChorusSession() async {
    final wasMember = isChorusMember;
    _chorusAutoStop = true;
    await api.leaveChorus().catchError((_) {});
    chorus = null;
    _stopChorusLoop();
    _stopMemberTicker();
    if (wasMember) await _player.pause();
    notifyListeners();
  }

  Future<void> toggle() async {
    if (isChorusMember) {
      _sendCommand(playing: !chorus!.playing, positionMs: _memberPositionMs());
      return;
    }
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
    // Broadcast handled by the playerStateStream transition listener.
  }

  // Manual next/previous wrap around the ends so a playlist always loops.
  Future<void> next() async {
    if (isChorusMember) {
      final n = chorus!.queueIds.length;
      if (n == 0) return;
      _sendCommand(index: (chorus!.index + 1) % n, positionMs: 0, playing: true);
      return;
    }
    if (_player.hasNext) {
      await _player.seekToNext();
    } else {
      await _player.seek(Duration.zero, index: 0); // wrap to first
    }
    _broadcastChorus();
  }

  Future<void> previous() async {
    if (isChorusMember) {
      final n = chorus!.queueIds.length;
      if (n == 0) return;
      if (_memberPositionMs() > 3000) {
        _sendCommand(positionMs: 0);
      } else {
        _sendCommand(index: (chorus!.index - 1 + n) % n, positionMs: 0, playing: true);
      }
      return;
    }
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
    if (isChorusMember) {
      _sendCommand(positionMs: d.inMilliseconds);
      _memberPosBaseMs = d.inMilliseconds; // optimistic local UI
      _memberPosBaseAt = DateTime.now().millisecondsSinceEpoch;
      notifyListeners();
      return;
    }
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
    if (t == null) {
      _lyricsForId = null;
      return;
    }
    _lyricsForId = t.id;
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
    if (isChorusMember) return; // members have no local audio to watch
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
    _chorusTick?.cancel();
    _memberTicker?.cancel();
    _listenLooping = false;
    _chorusLooping = false;
    _player.dispose();
    super.dispose();
  }
}
