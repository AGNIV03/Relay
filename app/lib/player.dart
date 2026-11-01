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
  // Tuned buffering: start playback sooner (lower bufferForPlayback) so the gap
  // between tracks and on first play is shorter, while keeping a healthy buffer to
  // ride out network jitter. androidLoadControl applies on Android (ExoPlayer);
  // desktop media_kit ignores it and uses its own buffer + playlist prefetch
  // (enabled in main.dart).
  final AudioPlayer _player = AudioPlayer(
    audioLoadConfiguration: const AudioLoadConfiguration(
      androidLoadControl: AndroidLoadControl(
        minBufferDuration: Duration(seconds: 20),
        maxBufferDuration: Duration(seconds: 60),
        bufferForPlaybackDuration: Duration(milliseconds: 1200),
        bufferForPlaybackAfterRebufferDuration: Duration(seconds: 3),
      ),
    ),
  );

  List<Track> _queue = [];
  ConcatenatingAudioSource? _source; // kept so we can add/insert into the queue
  int _index = 0;
  // The playlist this queue was started from (null if not from a playlist), sent
  // on scrobble so Recently Played can group by playlist.
  String? _playlistContext;
  bool _shuffle = false;
  // Two-layer queue (Spotify-style). The audio engine plays one flat list
  // (_queue); _userQ[i] marks whether _queue[i] is a USER-queued item — added via
  // "Play next" / "Add to queue" (true) — or part of the CONTEXT you started from,
  // i.e. the playlist/album/songs list (false). User-queue items sit right after
  // the current track and play before the context resumes. The flag travels with
  // its entry through every insert/remove, so the two sections stay correct with
  // no duplicates. _contextOriginal keeps the context's unshuffled order so
  // turning shuffle off can restore it.
  final List<bool> _userQ = [];
  List<Track> _contextOriginal = [];
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
  bool _restored = false; // restoreSession() runs once (constructor + UI both call it)

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
      if (_previewing) return; // Rewind preview owns the engine; _index is the saved queue's
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
      if (_previewing) {
        notifyListeners();
        return;
      }
      _saveSession();
      _postActivity();
      // Host: broadcast play/pause transitions (covers OS / lock-screen controls).
      if (isChorusHost && !_applyingChorus && st.playing != _lastHostPlaying) {
        _lastHostPlaying = st.playing;
        _broadcastChorus();
      }
      notifyListeners();
    });
    _player.processingStateStream.listen((st) {
      if (_previewing || st != ProcessingState.completed) return;
      // A stopped listen-along session finishes the current song then returns to
      // the user's own queue.
      if (_restoreAfterCurrent) {
        _restoreAfterCurrent = false;
        if (_savedQueue.isNotEmpty) playQueue(_savedQueue, start: _savedIndex);
        return;
      }
      // Genuine end of the queue (repeat off): finish, stop, and clear the
      // now-playing controls entirely instead of freezing at the last second.
      if (!isChorusMember) _clearPlayback();
    });
    _player.positionStream.listen((pos) {
      // Rewind previews never count as plays (they'd skew next year's stats).
      if (!_previewing && !_scrobbled && pos.inSeconds >= 5 && current != null) {
        _scrobbled = true;
        api.scrobble(current!.id, playlistId: _playlistContext).catchError((_) {});
      }
      // Position ticks go to their own notifier: only the progress bar, time
      // labels, mini-player ring and lyrics listen to it. Notifying the whole
      // model here rebuilt every PlayerModel watcher (player bar, track tables,
      // friends panel, queue…) several times a second, which dominated CPU use on
      // desktop. Track / play-state / queue changes still notifyListeners().
      if (!isChorusMember) positionTick.value = pos;
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
        // Resume-card play on a restored session: load + play from the saved
        // position (this lazily creates the platform player, after which the
        // normal handler owns playback).
        resume: () => _player.play(),
      );
    }
    // Session revoked server-side: stop audio + wipe the queue, exactly like a
    // manual sign-out, so nothing keeps playing behind the login screen.
    api.sessionRevoked.addListener(() => signOutReset());
    // Restore the last session on startup so a cold Android Auto launch shows the
    // last-played song + position (paused) without opening the app first.
    restoreSession();
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
    if (_previewing) return; // don't broadcast Rewind previews to friends
    api
        .postActivity(
          trackId: current?.id,
          positionMs: position.inMilliseconds,
          // Server-clock time at which that position was true (null until synced).
          atServerMs: api.serverNowEstimate,
          playing: playing,
          listeningTo: listenHostId, // host we're listening-along to (or null)
        )
        .catchError((_) {});
  }

  bool get listeningAlong => listenHostId != null;

  /// The playback position, updated several times a second while playing. Listen
  /// to THIS (e.g. ValueListenableBuilder) for anything that tracks the play head;
  /// the model itself only notifies on track / play-state / queue changes.
  final ValueNotifier<Duration> positionTick = ValueNotifier(Duration.zero);

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

  MediaItem _mediaItemFor(Track t) => MediaItem(
        id: t.id,
        title: t.title,
        artist: t.artistName,
        album: t.albumTitle,
        artUri: Uri.parse(api.trackCoverUrl(t.id)),
      );

  AudioSource _sourceFor(Track t) {
    final local = downloads.localPath(t.id);
    final uri = local != null ? Uri.file(local) : Uri.parse(api.streamUrl(t.id));
    return AudioSource.uri(uri, tag: _mediaItemFor(t));
  }

  // Insert/remove that keep _queue, _userQ and the audio source in lockstep.
  Future<void> _insertEntry(int at, Track t, bool userQueued) async {
    _queue.insert(at, t);
    _userQ.insert(at, userQueued);
    await _source!.insert(at, _sourceFor(t));
  }

  Future<void> _removeEntry(int at) async {
    _queue.removeAt(at);
    _userQ.removeAt(at);
    await _source!.removeAt(at);
  }

  /// First index after the current track that belongs to the CONTEXT — i.e. just
  /// past the contiguous block of user-queued items. New "Add to queue" songs go
  /// here so the manual queue stays in FIFO order ahead of the context.
  int _userQueueEnd() {
    var at = _index + 1;
    while (at < _queue.length && at < _userQ.length && _userQ[at]) {
      at++;
    }
    return at;
  }

  /// Whether the upcoming entry at [i] is a manually-queued item (vs context).
  bool isUserQueuedAt(int i) =>
      !isChorusMember && i >= 0 && i < _userQ.length && i < _queue.length && _userQ[i];

  Future<void> playQueue(List<Track> tracks,
      {int start = 0, String? playlistId, bool? shuffle, bool anchorStart = true}) async {
    if (tracks.isEmpty) return;
    _playlistContext = playlistId;
    // `shuffle` overrides the global shuffle mode for THIS play only (used by the
    // per-playlist shuffle toggle) without flipping the playback-controls shuffle.
    final doShuffle = shuffle ?? _shuffle;
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
    // A fresh context fully REPLACES the previous queue (incl. any manual queue).
    _contextOriginal = List.of(tracks);
    // With shuffle on we reorder the queue itself (not just_audio's shuffle mode)
    // so the visible queue is the real play order and chorus members match. Two
    // modes: when [anchorStart] (the user tapped a specific track) the tapped
    // track plays first and the rest follow randomly; otherwise (a whole-list
    // "Play"/"Shuffle" action) the ENTIRE list is randomized, so the first song
    // is random too — not the list's original first track.
    if (doShuffle && tracks.length > 1) {
      if (anchorStart) {
        final first = tracks[start];
        final rest = [
          for (var i = 0; i < tracks.length; i++)
            if (i != start) tracks[i]
        ]..shuffle();
        _queue = [first, ...rest];
      } else {
        _queue = List.of(tracks)..shuffle();
      }
      _index = 0;
    } else {
      _queue = List.of(tracks);
      _index = start;
    }
    _userQ
      ..clear()
      ..addAll(List.filled(_queue.length, false)); // all context, no manual queue
    _scrobbled = false;
    _loadLyrics();
    notifyListeners();
    try {
      _source = ConcatenatingAudioSource(children: _queue.map(_sourceFor).toList());
      await _player.setAudioSource(_source!, initialIndex: _index);
      await _player.play();
      _saveSession();
      // Chorus is opt-in: playback no longer auto-hosts a session. The user
      // starts Chorus explicitly from its control.
      if (isChorusHost) _broadcastChorus();
    } catch (e) {
      debugPrint('play error: $e');
    }
  }

  /// Add to the user queue: plays after the current track and any already-queued
  /// songs, but before the rest of the context resumes.
  Future<void> addToQueue(Track t) async {
    if (isChorusMember) {
      _sendCommand(queue: [...chorus!.queueIds, t.id], index: chorus!.index);
      return;
    }
    if (_source == null || _queue.isEmpty) return playQueue([t]);
    await _insertEntry(_userQueueEnd(), t, true);
    notifyListeners();
    _broadcastChorus();
  }

  /// Add a whole list (e.g. a playlist) to the user queue, in order, after the
  /// current track and anything already queued. Starts playing it if nothing is
  /// loaded.
  Future<void> addAllToQueue(List<Track> tracks) async {
    if (tracks.isEmpty) return;
    if (isChorusMember) {
      _sendCommand(
          queue: [...chorus!.queueIds, ...tracks.map((t) => t.id)], index: chorus!.index);
      return;
    }
    if (_source == null || _queue.isEmpty) return playQueue(tracks);
    var at = _userQueueEnd();
    for (final t in tracks) {
      await _insertEntry(at++, t, true);
    }
    notifyListeners();
    _broadcastChorus();
    _saveSession();
  }

  /// Clear what's coming up; the current track keeps playing. With
  /// [userQueueOnly] only the manually queued songs ("Next in queue") go and the
  /// context (playlist/album) carries on; otherwise everything after the current
  /// track is removed. User-queued items always form one contiguous block right
  /// after the current track, so both cases are a single range removal.
  Future<void> clearQueue({bool userQueueOnly = false}) async {
    if (isChorusMember) {
      // Members have no separate manual queue; ask the host to drop the upcoming.
      final ids = chorus!.queueIds;
      final keep = ids.sublist(0, (chorus!.index + 1).clamp(0, ids.length));
      _sendCommand(queue: keep, index: chorus!.index);
      return;
    }
    if (_source == null || _queue.isEmpty) return;
    final start = _index + 1;
    final end = userQueueOnly ? _userQueueEnd() : _queue.length;
    if (end <= start) return;
    _queue.removeRange(start, end);
    _userQ.removeRange(start, end);
    await _source!.removeRange(start, end);
    notifyListeners();
    _broadcastChorus();
    _saveSession();
  }

  /// Play next: jumps to the front of the user queue (right after the current
  /// track), ahead of anything already queued.
  Future<void> playNext(Track t) async {
    if (isChorusMember) {
      final ids = [...chorus!.queueIds];
      final at = (chorus!.index + 1).clamp(0, ids.length);
      ids.insert(at, t.id);
      _sendCommand(queue: ids, index: chorus!.index);
      return;
    }
    if (_source == null || _queue.isEmpty) return playQueue([t]);
    await _insertEntry(_index + 1, t, true);
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
    await _removeEntry(index);
    notifyListeners();
    _broadcastChorus();
  }

  /// Reorder an upcoming queue item (drag-to-reorder). Both indices must be after
  /// the current track; the userQ flag travels with the entry so the two queue
  /// sections stay correct.
  Future<void> moveInQueue(int from, int to) async {
    if (isChorusMember) {
      final ci = chorus!.index;
      if (from <= ci || to <= ci) return;
      final ids = [...chorus!.queueIds];
      if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from == to) return;
      final id = ids.removeAt(from);
      ids.insert(to, id);
      _sendCommand(queue: ids, index: ci);
      return;
    }
    if (_source == null) return;
    if (from <= _index || to <= _index) return;
    if (from < 0 || from >= _queue.length || to < 0 || to >= _queue.length || from == to) return;
    final t = _queue.removeAt(from);
    final f = _userQ.removeAt(from);
    _queue.insert(to, t);
    _userQ.insert(to, f);
    await _source!.move(from, to);
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
    await api.syncClock(force: true); // measure clock offset before the first apply
    _listenLooping = true;
    _listenLoop();
  }

  /// Long-poll the host's activity and keep our playback in lock-step.
  Future<void> _listenLoop() async {
    var backoffMs = 1000;
    while (_listenLooping && listenHostId != null) {
      final hostId = listenHostId!;
      unawaited(api.syncClock()); // cached; re-measures every few minutes
      HostActivity a;
      try {
        a = await api.userActivityPoll(hostId, _listenVersion);
      } on ApiException catch (e) {
        if (e.status == 403) {
          // They turned off sharing / listen-along: stop following instead of
          // retrying forever.
          if (listenHostId == hostId) stopListenAlong();
          break;
        }
        await Future.delayed(Duration(milliseconds: backoffMs));
        backoffMs = (backoffMs * 2).clamp(1000, 30000);
        continue;
      } catch (_) {
        await Future.delayed(Duration(milliseconds: backoffMs));
        backoffMs = (backoffMs * 2).clamp(1000, 30000); // exponential backoff
        continue;
      }
      backoffMs = 1000;
      if (!_listenLooping || listenHostId != hostId) break;
      _listenVersion = a.version;
      await _applyHostActivity(a);
    }
  }

  /// Where the host's playback is RIGHT NOW: their reported position plus the
  /// time elapsed since it was true. With a measured clock offset that's
  /// (our estimate of server now - updatedAt), which also covers the time this
  /// response spent in transit; otherwise fall back to the server's own clock at
  /// response time (misses the download leg).
  int _hostTargetMs(HostActivity a) {
    var advance = 0;
    if (a.playing && a.updatedAt != null) {
      final srvNow = api.serverNowEstimate ?? (a.serverNow > 0 ? a.serverNow : null);
      if (srvNow != null) advance = srvNow - a.updatedAt!;
    }
    final t = a.positionMs + (advance > 0 ? advance : 0);
    return t < 0 ? 0 : t;
  }

  Future<void> _applyHostActivity(HostActivity a) async {
    if (listenHostId == null) return;
    if (!a.online) {
      stopListenAlong();
      return;
    }
    if (a.track == null) return;
    var targetMs = _hostTargetMs(a);
    if (current?.id != a.track!.id) {
      _queue = [a.track!];
      _userQ
        ..clear()
        ..add(false);
      _contextOriginal = [a.track!];
      _index = 0;
      _scrobbled = false;
      _loadLyrics();
      notifyListeners();
      try {
        _source = ConcatenatingAudioSource(children: [_sourceFor(a.track!)]);
        await _player.setAudioSource(_source!, initialPosition: Duration(milliseconds: targetMs));
        if (a.playing) {
          // Not awaited: play() only resolves on pause. Once audio is actually
          // running, re-seek to cover the time spent loading/buffering.
          _player.play();
          await _player.processingStateStream
              .firstWhere((st) => st == ProcessingState.ready)
              .timeout(const Duration(seconds: 15), onTimeout: () => ProcessingState.ready);
          if (listenHostId != null && current?.id == a.track!.id) {
            final fresh = _hostTargetMs(a);
            if ((_player.position.inMilliseconds - fresh).abs() > 250) {
              await _player.seek(Duration(milliseconds: fresh));
            }
          }
        } else {
          await _player.pause();
        }
      } catch (e) {
        debugPrint('listen-along load error: $e');
      }
    } else {
      // With a measured clock offset the estimate is good to a few hundred ms,
      // so correct smaller drift; without one, keep the old loose threshold.
      final tolerance = api.clockOffsetMs != null ? 700 : 2000;
      if ((_player.position.inMilliseconds - targetMs).abs() > tolerance) {
        await _player.seek(Duration(milliseconds: targetMs));
      }
      if (a.playing && !_player.playing) await _player.play();
      if (!a.playing && _player.playing) await _player.pause();
    }
  }

  /// Finish/stop and wipe the now-playing controls (queue ran out, repeat off).
  Future<void> _clearPlayback() async {
    try {
      await _player.stop();
    } catch (_) {}
    _queue = [];
    _userQ.clear();
    _contextOriginal = [];
    _index = 0;
    _source = null;
    _scrobbled = false;
    _lyrics = null;
    _lyricsForId = null;
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(_kSession); // don't resume a finished playlist next launch
    } catch (_) {}
    notifyListeners();
    if (isChorusHost) _broadcastChorus(); // members clear their controls too
  }

  /// Stop and wipe everything on sign-out: audio, queue, lyrics, chorus,
  /// listen-along, and the saved session — so nothing keeps playing once the user
  /// is logged out (and it won't resume on next launch).
  Future<void> signOutReset() async {
    _chorusLooping = false;
    _listenLooping = false;
    _stopMemberTicker();
    chorus = null;
    listenHostId = null;
    listenHostName = null;
    _restoreAfterCurrent = false;
    try {
      await _player.stop();
    } catch (_) {}
    _queue = [];
    _userQ.clear();
    _contextOriginal = [];
    _index = 0;
    _source = null;
    _scrobbled = false;
    _lyrics = null;
    _lyricsForId = null;
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(_kSession);
    } catch (_) {}
    notifyListeners();
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
  void _startChorusLoop() {
    unawaited(api.syncClock(force: true)); // host stamps + member extrapolation
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
    var backoffMs = 1000;
    while (_chorusLooping) {
      ChorusState? c;
      try {
        c = await api.chorusPoll(_chorusVersion);
      } catch (_) {
        await Future.delayed(Duration(milliseconds: backoffMs));
        backoffMs = (backoffMs * 2).clamp(1000, 30000); // exponential backoff
        continue;
      }
      backoffMs = 1000; // reset after a successful poll
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
    // Same idea as listen-along: extrapolate from when the host's position was
    // true, using our server-clock estimate when we have one.
    final srvNow = api.serverNowEstimate ?? (c.serverNow > 0 ? c.serverNow : null);
    final advance = (c.playing && srvNow != null) ? (srvNow - c.updatedAt) : 0;
    _memberPosBaseMs = c.positionMs + (advance > 0 ? advance : 0);
    _memberPosBaseAt = DateTime.now().millisecondsSinceEpoch;
    positionTick.value = Duration(milliseconds: _memberPositionMs());
  }

  void _ensureMemberTicker() {
    _memberTicker ??= Timer.periodic(const Duration(milliseconds: 300), (_) {
      if (isChorusMember && chorus!.playing) {
        positionTick.value = Duration(milliseconds: _memberPositionMs());
      }
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
        final curId = current?.id;
        // A queue EDIT that keeps the current track (add to queue / play next /
        // remove upcoming) with no explicit seek or play/pause → reconcile the
        // upcoming items in place WITHOUT restarting the current song. Anything
        // else (song change, explicit seek/play) → rebuild the source.
        // A queue EDIT that keeps the current track (add to queue / play next /
        // remove upcoming) with no explicit seek or play/pause → reconcile just
        // the upcoming items WITHOUT restarting the current song. Anything else
        // (song change, explicit seek/play) → rebuild the source.
        final keepsCurrent =
            curId != null && _source != null && tQueue.contains(curId) && tPos == null && tPlaying == null;
        if (keepsCurrent) {
          await _reconcileUpcoming(tQueue, c);
        } else {
          final resolved = await _resolveTracks(tQueue, c);
          if (resolved.isNotEmpty) {
            _queue = resolved;
            _userQ
              ..clear()
              ..addAll(List.filled(_queue.length, false));
            _contextOriginal = List.of(_queue);
            _index = (tIndex ?? 0).clamp(0, _queue.length - 1);
            _scrobbled = false;
            _loadLyrics();
            _source = ConcatenatingAudioSource(children: _queue.map(_sourceFor).toList());
            await _player.setAudioSource(_source!,
                initialIndex: _index, initialPosition: Duration(milliseconds: tPos ?? 0));
          }
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

  /// Host: replace the UPCOMING portion of the queue with [newIds] (everything
  /// after the current track), leaving the current track playing untouched. We
  /// rebuild the whole upcoming region rather than diffing it in place — that's
  /// gapless AND can't duplicate entries (the old in-place diff could leave a
  /// moved track in place *and* re-insert it).
  Future<void> _reconcileUpcoming(List<String> newIds, ChorusState c) async {
    if (_source == null) return;
    final curId = current?.id;
    final ci = curId == null ? -1 : newIds.indexOf(curId);
    final desired = ci >= 0 ? newIds.sublist(ci + 1) : newIds;
    // Drop everything after the current track.
    while (_queue.length > _index + 1) {
      await _removeEntry(_queue.length - 1);
    }
    // Re-add the desired upcoming order (member-driven items count as context).
    for (final id in desired) {
      final t = await _resolveOne(id, c);
      if (t != null) await _insertEntry(_queue.length, t, false);
    }
  }

  /// Resolve a single track id (local queue → hydrated chorus queue → server).
  Future<Track?> _resolveOne(String id, ChorusState c) async {
    for (final t in _queue) {
      if (t.id == id) return t;
    }
    for (final t in c.queue) {
      if (t.id == id) return t;
    }
    try {
      final r = await api.tracksByIds([id]);
      if (r.isNotEmpty) return r.first;
    } catch (_) {}
    return null;
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
          atServerMs: api.serverNowEstimate, // when that position was true
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
      positionTick.value = d;
      notifyListeners();
      return;
    }
    await _player.seek(d);
    _broadcastChorus();
  }

  /// Seek relative to the current position, clamped to [0, duration]. Used by the
  /// desktop left/right-arrow shortcuts (±10s). Routes through [seek] so it works
  /// for a chorus member (remote command) too.
  Future<void> nudgeSeek(Duration delta) async {
    var target = position + delta;
    if (target < Duration.zero) target = Duration.zero;
    final d = duration;
    if (d > Duration.zero && target > d) target = d;
    await seek(target);
  }

  /// Adjust volume by [delta], clamped to [0, 1]. Used by the desktop up/down-arrow
  /// and mouse-wheel volume shortcuts.
  Future<void> nudgeVolume(double delta) async {
    await setVolume((volume + delta).clamp(0.0, 1.0));
  }

  Future<void> setVolume(double v) async {
    await _player.setVolume(v);
    notifyListeners(); // update the slider immediately, even while paused
  }

  double get volume => _player.volume;

  // ---- Repeat (off / all / one) + shuffle ----
  LoopMode get loopMode => _player.loopMode;
  bool get shuffleEnabled => _shuffle;

  Future<void> cycleRepeat() async {
    const order = [LoopMode.off, LoopMode.all, LoopMode.one];
    final next = order[(order.indexOf(_player.loopMode) + 1) % order.length];
    await _player.setLoopMode(next);
    notifyListeners();
  }

  Future<void> toggleShuffle() => setShuffle(!_shuffle);

  /// Turn shuffle on/off. Only the UPCOMING CONTEXT is reordered — the current
  /// track keeps playing (gapless) and the user queue stays in place. Turning it
  /// off restores the context's original order. Done by editing only the entries
  /// after the current one, so it never disturbs playback or duplicates anything.
  Future<void> setShuffle(bool on) async {
    // A silent member can't reorder locally — ask the host to reshuffle.
    if (isChorusMember) {
      final q = chorus!.queue;
      final i = chorus!.index;
      if (q.length <= 1) return;
      final cur = q[i];
      final rest = [
        for (var k = 0; k < q.length; k++)
          if (k != i) q[k]
      ]..shuffle();
      final reordered = [cur, ...rest];
      _sendCommand(queue: reordered.map((t) => t.id).toList(), index: 0);
      return;
    }
    if (on == _shuffle) return;
    _shuffle = on;
    if (_queue.isEmpty || _source == null) {
      notifyListeners();
      return;
    }
    // Split the upcoming region into its user-queue and context parts.
    final upcomingUser = <Track>[];
    final upcomingContext = <Track>[];
    for (var i = _index + 1; i < _queue.length; i++) {
      (_userQ[i] ? upcomingUser : upcomingContext).add(_queue[i]);
    }
    if (upcomingContext.length > 1) {
      if (on) {
        upcomingContext.shuffle();
      } else {
        // Restore the context's original relative order.
        final orig = <String, int>{
          for (var i = 0; i < _contextOriginal.length; i++) _contextOriginal[i].id: i
        };
        upcomingContext.sort(
            (a, b) => (orig[a.id] ?? 1 << 30).compareTo(orig[b.id] ?? 1 << 30));
      }
    }
    // Rebuild only the upcoming region (everything after the current track):
    // user queue first (FIFO), then the reordered context. Current keeps playing.
    while (_queue.length > _index + 1) {
      await _removeEntry(_queue.length - 1);
    }
    for (final t in upcomingUser) {
      await _insertEntry(_queue.length, t, true);
    }
    for (final t in upcomingContext) {
      await _insertEntry(_queue.length, t, false);
    }
    notifyListeners();
    _broadcastChorus();
    _saveSession();
  }

  /// Shuffle a list and start playing immediately (used by "Shuffle" buttons).
  /// Randomizes the whole list, so the first song is random too.
  Future<void> shuffleAndPlay(List<Track> tracks, {String? playlistId}) async {
    if (tracks.isEmpty) return;
    _shuffle = true;
    await playQueue(tracks, playlistId: playlistId, shuffle: true, anchorStart: false);
  }

  // ---- Preview mode (Rewind background music) ----
  // The Android audio backend supports only ONE AudioPlayer, so Rewind can't own
  // a player of its own. Instead it borrows this one: beginPreview() snapshots the
  // real queue/position/state, previewTrack() crossfades between song snippets,
  // and endPreview() puts the user's queue back exactly where it was. While
  // previewing, nothing scrobbles, saves the session, broadcasts presence or
  // triggers stall recovery / end-of-queue cleanup (see the _previewing guards).
  bool _previewing = false;
  List<Track> _pvQueue = [];
  List<bool> _pvUserQ = [];
  List<Track> _pvContext = [];
  int _pvIndex = 0;
  Duration _pvPos = Duration.zero;
  bool _pvWasPlaying = false;
  LoopMode _pvLoop = LoopMode.off;
  double _pvVolume = 1.0;
  String? _pvPlaylist;
  int _pvToken = 0; // bumps on every preview op so a superseded fade/load bails out
  double _pvTarget = 1.0; // preview loudness (0 when muted)

  bool get previewing => _previewing;

  /// Start borrowing the player for previews. Returns false (stay silent) while
  /// in a Chorus or listen-along, where hijacking playback would break the session.
  Future<bool> beginPreview() async {
    if (_previewing) return true;
    if (inChorus || listeningAlong) return false;
    _pvQueue = List.of(_queue);
    _pvUserQ = List.of(_userQ);
    _pvContext = List.of(_contextOriginal);
    _pvIndex = _index;
    _pvPos = _player.position;
    _pvWasPlaying = _player.playing;
    _pvLoop = _player.loopMode;
    _pvVolume = _player.volume;
    _pvPlaylist = _playlistContext;
    _pvTarget = _pvVolume > 0 ? _pvVolume : 1.0;
    await _saveSession(); // persist the real session before the engine is touched
    _previewing = true;
    try {
      if (_player.playing) await _fadeTo(0, 300);
      await _player.pause();
      // Loop the snippet so a short card never "completes" the source.
      await _player.setLoopMode(LoopMode.one);
    } catch (_) {}
    return true;
  }

  /// Crossfade to [t], starting ~30% in (past most intros, often near a chorus).
  Future<void> previewTrack(Track t) async {
    if (!_previewing) return;
    final token = ++_pvToken;
    try {
      if (_player.playing) await _fadeTo(0, 350, token: token);
      if (token != _pvToken) return;
      await _player.setAudioSource(_sourceFor(t), initialPosition: _previewStart(t));
      if (token != _pvToken) return;
      await _player.setVolume(0);
      _player.play(); // not awaited: just_audio's play() resolves only on pause/stop
      await _fadeTo(_pvTarget, 700, token: token);
    } catch (e) {
      debugPrint('preview error: $e');
    }
  }

  Duration _previewStart(Track t) {
    final secs = t.duration;
    if (secs <= 0) return Duration.zero;
    final s = (secs * 0.3).clamp(0, 75);
    return Duration(milliseconds: (s * 1000).round());
  }

  /// Hold-to-pause on a Rewind card pauses the music too.
  Future<void> setPreviewPaused(bool paused) async {
    if (!_previewing) return;
    if (paused) {
      await _player.pause();
    } else {
      _player.play();
    }
  }

  Future<void> setPreviewMuted(bool muted) async {
    if (!_previewing) return;
    _pvTarget = muted ? 0 : (_pvVolume > 0 ? _pvVolume : 1.0);
    ++_pvToken; // cancel any in-flight fade so it doesn't override the mute
    await _player.setVolume(_pvTarget);
  }

  /// Stop previewing and restore the user's queue, position, repeat mode, volume
  /// and play state exactly as they were before Rewind opened.
  Future<void> endPreview() async {
    if (!_previewing) return;
    final token = ++_pvToken;
    try {
      if (_player.playing) await _fadeTo(0, 300, token: token);
      await _player.pause();
    } catch (_) {}
    _queue = _pvQueue;
    _userQ
      ..clear()
      ..addAll(_pvUserQ);
    _contextOriginal = _pvContext;
    _index = _pvIndex;
    _playlistContext = _pvPlaylist;
    try {
      await _player.setLoopMode(_pvLoop);
      if (_queue.isNotEmpty) {
        _source = ConcatenatingAudioSource(children: _queue.map(_sourceFor).toList());
        await _player.setAudioSource(_source!,
            initialIndex: _index, initialPosition: _pvPos, preload: _pvWasPlaying);
      } else {
        _source = null;
        await _player.stop();
      }
      await _player.setVolume(_pvVolume);
    } catch (e) {
      debugPrint('preview restore error: $e');
    }
    _previewing = false;
    _lastPos = _pvPos;
    _frozenTicks = 0;
    if (_queue.isNotEmpty) {
      if (_pvWasPlaying) {
        _player.play();
      } else if (!kIsWeb && Platform.isAndroid) {
        // Paused + not preloaded: republish so the notification / car card shows
        // the user's own song again instead of the last preview.
        setMediaBrowsingNowPlaying(
          item: _mediaItemFor(_queue[_index]),
          queue: _queue.map(_mediaItemFor).toList(),
          index: _index,
          position: _pvPos,
        );
      }
    }
    notifyListeners();
  }

  Future<void> _fadeTo(double target, int ms, {int? token}) async {
    final from = _player.volume;
    const steps = 12;
    for (var i = 1; i <= steps; i++) {
      if (token != null && token != _pvToken) return;
      await _player.setVolume(from + (target - from) * i / steps);
      await Future.delayed(Duration(milliseconds: ms ~/ steps));
    }
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
    // Offline / downloaded: use the lyrics saved alongside the download so they
    // show with no connection. Online tracks fall through to the server fetch.
    final local = downloads.localLyrics(t.id);
    if (local != null) {
      _lyrics = local;
      notifyListeners();
      return;
    }
    try {
      final l = await api.lyrics(t.id);
      downloads.saveLyrics(t.id, l); // downloaded track → keep a copy for offline
      if (current?.id == t.id) {
        _lyrics = l;
        notifyListeners();
      }
    } catch (_) {
      // Unreachable (e.g. offline with no saved copy): show "No lyrics" instead
      // of an endless "Loading lyrics…".
      if (current?.id == t.id) {
        _lyrics = Lyrics();
        notifyListeners();
      }
    }
  }

  // ---- Stall recovery (cutout mitigation) ----
  // Runs every 4s. Detects two failure modes that otherwise require a manual
  // rewind/pause/play to recover, and reloads the stream automatically:
  //   • ready + position frozen  → a silent mid-track cutout (recover after ~8s)
  //   • buffering + position frozen → the stream stalled / connection dropped and
  //     never resumes (recover after ~16s, allowing for genuinely slow networks)
  void _checkStall() {
    if (_previewing) return; // a preview isn't the saved queue — never "recover" it
    if (isChorusMember) return; // members have no local audio to watch
    if (listenHostId != null) return; // playback is host-driven while following
    final t = current;
    if (t == null || _recovering) return;
    final isStreaming = downloads.localPath(t.id) == null;
    if (!isStreaming) {
      _frozenTicks = 0;
      _lastPos = _player.position;
      return;
    }
    final st = _player.processingState;

    // Only a session we're actively trying to play can "stall". If we're not
    // playing — a user pause, or a freshly restored session that was never started
    // — there is nothing to recover. This guard MUST come before the idle branch
    // below: the desktop (media_kit) backend reports a restored, paused,
    // not-yet-played source as `idle`, which would otherwise be mistaken for a dead
    // stream and "recovered" into playback a few seconds after launch (the auto-play
    // bug). `.playing` reflects the user's play/pause intent, so a stream that dies
    // mid-playback still reads playing == true and is recovered correctly.
    if (!_player.playing) {
      _frozenTicks = 0;
      _lastPos = _player.position;
      return;
    }

    // HARD STOP: a dropped/failed stream surfaces on the desktop (media_kit)
    // backend as `idle` with the track still loaded — playback just dies and never
    // resumes (switch-track / rewind+play was the only way back). We're actively
    // playing (guarded above), so idle == a dead stream → reload it.
    if (st == ProcessingState.idle) {
      _frozenTicks++;
      if (_frozenTicks >= 2) {
        _recoverStream();
        return;
      }
      _lastPos = _player.position;
      return;
    }

    // SILENT CUTOUT / SLOW STALL: still "playing" but the position is frozen.
    final progressing = _player.position != _lastPos;
    if (st == ProcessingState.ready || st == ProcessingState.buffering) {
      if (!progressing) {
        _frozenTicks++;
        final limit = st == ProcessingState.buffering ? 4 : 2; // ~16s vs ~8s
        if (_frozenTicks >= limit) {
          _recoverStream();
          return;
        }
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
    // On an errored/idle backend the live position can read 0; fall back to the
    // last position we observed so we resume at the cutout, not the track start.
    final at = _player.position > _lastPos ? _player.position : _lastPos;
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
    if (_previewing || _queue.isEmpty) return;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(
        _kSession,
        jsonEncode({
          'queue': _queue.map((t) => t.toJson()).toList(),
          'userQ': _userQ,
          'index': _index,
          'position': _player.position.inMilliseconds,
        }),
      );
    } catch (_) {}
  }

  /// Restore the last session paused at its saved position (call on startup).
  Future<void> restoreSession() async {
    if (_restored) return; // idempotent: called from the constructor and the UI
    _restored = true;
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_kSession);
      if (raw == null) {
        debugPrint('[AA] restoreSession: no saved session');
        return;
      }
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final tracks = (data['queue'] as List).map((e) => Track.fromJson(e)).toList();
      if (tracks.isEmpty) return;
      _queue = tracks;
      final savedFlags = (data['userQ'] as List?)?.cast<bool>();
      _userQ
        ..clear()
        ..addAll(savedFlags != null && savedFlags.length == _queue.length
            ? savedFlags
            : List.filled(_queue.length, false));
      // The context for restore is the non-user-queued tracks, in queue order.
      _contextOriginal = [
        for (var i = 0; i < _queue.length; i++)
          if (!_userQ[i]) _queue[i]
      ];
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
      // Always start paused on (re)launch, even if the last session was playing —
      // the user resumes explicitly. Pause defensively in case a backend would
      // otherwise auto-start on setAudioSource.
      await _player.pause();
      // Android: publish the restored (paused) session to the media session so
      // the notification and a connected car's media card show the last-played
      // song + saved progress immediately — no audio is loaded until the user
      // presses play. (just_audio's platform player doesn't exist yet with
      // preload:false, so this is the only path that reaches the session.)
      if (!kIsWeb && Platform.isAndroid) {
        setMediaBrowsingNowPlaying(
          item: _mediaItemFor(_queue[_index]),
          queue: _queue.map(_mediaItemFor).toList(),
          index: _index,
          position: Duration(milliseconds: posMs),
        );
      }
      debugPrint('[AA] restoreSession: restored ${_queue.length} tracks at index $_index (paused)');
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
    positionTick.dispose();
    _player.dispose();
    super.dispose();
  }
}
