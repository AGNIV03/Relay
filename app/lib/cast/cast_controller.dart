import 'dart:async';

import 'package:flutter/foundation.dart';

import 'cast_channel.dart';
import 'cast_discovery.dart';

/// One queue entry handed to the receiver.
class CastItem {
  final String trackId;
  final String url;
  final String contentType;
  final String title;
  final String artist;
  final String album;
  final String? imageUrl;
  final double durationSecs;

  /// Sent as a server-side transcode: no byte ranges, so the receiver can't seek
  /// in it. Seeking re-requests it from the new position ([withOffset]).
  final bool transcoded;

  /// Seconds into the track this item's stream starts at (transcodes only).
  final double offsetSecs;

  const CastItem({
    required this.trackId,
    required this.url,
    required this.contentType,
    required this.title,
    required this.artist,
    required this.album,
    this.imageUrl,
    this.durationSecs = 0,
    this.transcoded = false,
    this.offsetSecs = 0,
  });

  /// This (transcoded) item starting [secs] in, via the server's `start=`.
  CastItem withOffset(double secs) {
    final base = url.replaceAll(RegExp(r'&start=[^&]*'), '');
    final max = durationSecs > 1 ? durationSecs - 1 : double.infinity;
    final s = secs.clamp(0.0, max).toDouble();
    return CastItem(
      trackId: trackId,
      url: s > 0 ? '$base&start=${s.toStringAsFixed(3)}' : base,
      contentType: contentType,
      title: title,
      artist: artist,
      album: album,
      imageUrl: imageUrl,
      durationSecs: durationSecs,
      transcoded: transcoded,
      offsetSecs: s,
    );
  }

  Map<String, dynamic> toMedia() => {
        'contentId': url,
        'contentUrl': url,
        'streamType': 'BUFFERED',
        'contentType': contentType,
        if (durationSecs > 0) 'duration': durationSecs - offsetSecs,
        'metadata': {
          'metadataType': 3, // MUSIC_TRACK
          'title': title,
          'artist': artist,
          if (album.isNotEmpty) 'albumName': album,
          if (imageUrl != null)
            'images': [
              {'url': imageUrl}
            ],
        },
        'customData': {'trackId': trackId},
      };
}

/// A session with one Cast device running the Default Media Receiver (app id
/// CC1AD845, needs no registration). Owns the socket, mirrors the receiver's
/// media status (play state, position, current track, volume) and reports track
/// changes / queue end / session loss back to the player through callbacks.
class CastController extends ChangeNotifier {
  static const appId = 'CC1AD845';

  CastDevice? device; // connected (or connecting) device
  bool connecting = false;
  String? error;

  CastChannel? _ch;
  StreamSubscription<CastMessage>? _sub;
  String? _transportId;
  String? _sessionId;
  int? _mediaSessionId;
  Timer? _statusPoll;
  Timer? _finishCheck;

  String playerState = 'IDLE'; // PLAYING | PAUSED | BUFFERING | IDLE
  String? idleReason;
  double _posSecs = 0;
  int _posAt = 0; // local ms when _posSecs was true
  double volume = 1.0;
  String? currentTrackId;
  int? _currentItemId;
  final _itemTrack = <int, String>{}; // queue itemId -> trackId

  /// What we last handed the receiver: the current item, then what follows.
  List<CastItem> _items = const [];

  /// Seconds into the track the current receiver stream starts at (a transcode
  /// re-requested from a seek point); 0 for everything else.
  double _offset = 0;

  /// Loudness-normalization gain for a track (1.0 = none). Applied as the
  /// receiver's *stream* volume, so the TV's own volume is left alone.
  double Function(String trackId)? gainFor;
  String? _gainKey; // "<mediaSessionId>:<trackId>@<gain>" last applied

  /// Receiver moved to another track (its own queue advanced, or a load landed).
  void Function(String trackId)? onTrackChanged;

  /// The receiver's loaded queue ran out (last item finished).
  void Function()? onQueueFinished;

  /// The session ended without us asking (app closed on the TV, network lost).
  void Function()? onLost;

  /// Play state / position re-based (for the player's UI notifications).
  void Function()? onStatus;

  bool get active => _transportId != null && device != null && (_ch?.isOpen ?? false);
  bool get playing => playerState == 'PLAYING' || playerState == 'BUFFERING';

  Duration get position {
    var s = _posSecs + _offset;
    if (playerState == 'PLAYING') s += (DateTime.now().millisecondsSinceEpoch - _posAt) / 1000;
    return Duration(milliseconds: (s * 1000).round().clamp(0, 1 << 40));
  }

  /// Connect to [d], launch the Default Media Receiver and join its session.
  Future<void> connect(CastDevice d) async {
    if (active) await disconnect();
    device = d;
    connecting = true;
    error = null;
    notifyListeners();
    final ch = CastChannel(d.host, d.port);
    try {
      await ch.connect();
      _ch = ch;
      _sub = ch.messages.listen(_onMessage);
      ch.done.then((_) {
        if (identical(_ch, ch)) _handleLost();
      });
      final st = await ch.request(CastChannel.nsReceiver, 'receiver-0',
          {'type': 'LAUNCH', 'appId': appId},
          timeout: const Duration(seconds: 20));
      if (st['type'] == 'LAUNCH_ERROR') throw Exception('${st['reason'] ?? 'Launch failed'}');
      var app = _findApp(st);
      if (app == null) {
        // Launching can take a few seconds; wait for a status that lists it.
        final m = await ch.messages
            .where((m) => m.namespace == CastChannel.nsReceiver && _findApp(m.json) != null)
            .first
            .timeout(const Duration(seconds: 20));
        app = _findApp(m.json);
      }
      _transportId = app!['transportId'] as String?;
      _sessionId = app['sessionId'] as String?;
      if (_transportId == null) throw Exception('Receiver did not start');
      ch.send(CastChannel.nsConnection, _transportId!, {'type': 'CONNECT'});
      ch.command(CastChannel.nsMedia, _transportId!, {'type': 'GET_STATUS'});
      _statusPoll = Timer.periodic(const Duration(seconds: 5), (_) {
        if (active) ch.command(CastChannel.nsMedia, _transportId!, {'type': 'GET_STATUS'});
      });
      connecting = false;
      notifyListeners();
    } catch (e) {
      debugPrint('cast connect failed: $e');
      error = 'Could not connect to ${d.name}';
      connecting = false;
      await _teardown();
      device = null;
      notifyListeners();
      rethrow;
    }
  }

  Map<String, dynamic>? _findApp(Map<String, dynamic> json) {
    final apps = (json['status'] is Map) ? (json['status']['applications'] as List?) : null;
    for (final a in apps ?? const []) {
      if (a is Map<String, dynamic> && a['appId'] == appId) return a;
    }
    return null;
  }

  /// Replace the receiver's queue with [items], starting at [startIndex].
  void load(List<CastItem> items,
      {int startIndex = 0,
      Duration position = Duration.zero,
      bool autoplay = true,
      bool repeatSingle = false}) {
    final ch = _ch;
    if (ch == null || _transportId == null || items.isEmpty) return;
    items = List.of(items);
    var startAt = position.inMilliseconds / 1000;
    // A transcode can't be seeked by the receiver: ask the server to start it
    // there instead, and remember the offset for the play head.
    if (items[startIndex].transcoded && startAt > 0.5) {
      items[startIndex] = items[startIndex].withOffset(startAt);
      startAt = 0;
    } else if (items[startIndex].offsetSecs > 0) {
      items[startIndex] = items[startIndex].withOffset(0);
    }
    _repeatSingle = repeatSingle;
    _items = items.sublist(startIndex);
    _offset = items[startIndex].offsetSecs;
    _itemTrack.clear();
    _currentItemId = null;
    _gainKey = null;
    currentTrackId = items[startIndex].trackId;
    _posSecs = startAt;
    _posAt = DateTime.now().millisecondsSinceEpoch;
    playerState = autoplay ? 'BUFFERING' : 'PAUSED';
    ch.command(CastChannel.nsMedia, _transportId!, {
      'type': 'QUEUE_LOAD',
      'sessionId': _sessionId,
      'items': [
        for (var i = 0; i < items.length; i++)
          {
            'media': items[i].toMedia(),
            'autoplay': i == startIndex ? autoplay : true,
            'preloadTime': 15,
            'startTime': 0,
          }
      ],
      'startIndex': startIndex,
      'repeatMode': repeatSingle ? 'REPEAT_SINGLE' : 'REPEAT_OFF',
      'currentTime': startAt,
    });
    notifyListeners();
  }

  void _media(String type, [Map<String, dynamic> extra = const {}]) {
    final ch = _ch;
    if (ch == null || _transportId == null || _mediaSessionId == null) return;
    ch.command(CastChannel.nsMedia, _transportId!,
        {'type': type, 'mediaSessionId': _mediaSessionId, ...extra});
  }

  void play() {
    _rebase();
    playerState = 'PLAYING';
    _posAt = DateTime.now().millisecondsSinceEpoch;
    _media('PLAY');
    notifyListeners();
  }

  void pause() {
    _rebase();
    playerState = 'PAUSED';
    _media('PAUSE');
    notifyListeners();
  }

  void seek(Duration d) {
    final secs = d.inMilliseconds / 1000;
    final cur = _items.isNotEmpty && _items.first.trackId == currentTrackId ? _items.first : null;
    if (cur != null && cur.transcoded) {
      // No byte ranges on a transcode: reload it from the new position (the
      // rest of the receiver queue rides along unchanged).
      load(_items, position: d, autoplay: playing, repeatSingle: _repeatSingle);
      return;
    }
    _offset = 0;
    _posSecs = secs;
    _posAt = DateTime.now().millisecondsSinceEpoch;
    _media('SEEK', {'currentTime': secs});
    notifyListeners();
  }

  /// Re-send the normalization gain (the normalize setting changed).
  void reapplyGain() {
    _gainKey = null;
    _applyGain();
  }

  void _applyGain() {
    final tid = currentTrackId;
    final msid = _mediaSessionId;
    if (tid == null || msid == null || gainFor == null) return;
    final g = gainFor!(tid).clamp(0.0, 1.0).toDouble();
    final key = '$msid:$tid@${g.toStringAsFixed(3)}';
    if (key == _gainKey) return;
    _gainKey = key;
    _media('SET_VOLUME', {
      'volume': {'level': g}
    });
  }

  /// Make the receiver's queue after the current item match [upcoming], without
  /// interrupting the current track (queue edits, autoplay picks, the window
  /// moving on after a track change).
  Future<void> syncUpcoming(List<CastItem> upcoming) async {
    final ch = _ch;
    final tid = _transportId;
    final msid = _mediaSessionId;
    if (ch == null || tid == null || msid == null || _items.isEmpty) return;
    try {
      final r0 = await ch.request(
          CastChannel.nsMedia, tid, {'type': 'QUEUE_GET_ITEM_IDS', 'mediaSessionId': msid});
      final ids = [for (final x in (r0['itemIds'] as List? ?? const [])) (x as num).toInt()];
      final unknown = ids.where((i) => !_itemTrack.containsKey(i)).toList();
      if (unknown.isNotEmpty) {
        final r = await ch.request(CastChannel.nsMedia, tid,
            {'type': 'QUEUE_GET_ITEMS', 'mediaSessionId': msid, 'itemIds': unknown});
        _recordItems(r['items'] as List?);
      }
      final cur = _currentItemId == null ? -1 : ids.indexOf(_currentItemId!);
      if (cur < 0 || !identical(_ch, ch) || _mediaSessionId != msid) return;
      final after = ids.sublist(cur + 1);
      final have = [for (final i in after) _itemTrack[i]];
      final want = [for (final u in upcoming) u.trackId];
      if (listEquals(have, want)) return;
      List<Map<String, dynamic>> qi(Iterable<CastItem> xs) => [
            for (final x in xs) {'media': x.toMedia(), 'autoplay': true, 'preloadTime': 15}
          ];
      var prefix = have.length < want.length;
      for (var k = 0; prefix && k < have.length; k++) {
        if (have[k] != want[k]) prefix = false;
      }
      if (!prefix && after.isNotEmpty) {
        await ch.request(CastChannel.nsMedia, tid,
            {'type': 'QUEUE_REMOVE', 'mediaSessionId': msid, 'itemIds': after});
      }
      final toAdd = prefix ? upcoming.sublist(have.length) : upcoming;
      if (toAdd.isNotEmpty) {
        await ch.request(CastChannel.nsMedia, tid,
            {'type': 'QUEUE_INSERT', 'mediaSessionId': msid, 'items': qi(toAdd)});
      }
      if (_items.isNotEmpty) _items = [_items.first, ...upcoming];
    } catch (e) {
      debugPrint('cast queue sync failed: $e');
    }
  }

  /// Repeat-one on the receiver (follows the player's loop mode).
  bool _repeatSingle = false;
  void setRepeatSingle(bool on) {
    if (on == _repeatSingle) return;
    _repeatSingle = on;
    _media('QUEUE_UPDATE', {'repeatMode': on ? 'REPEAT_SINGLE' : 'REPEAT_OFF'});
  }

  void _recordItems(List? items) {
    for (final it in items ?? const []) {
      if (it is Map) {
        final id = (it['itemId'] as num?)?.toInt();
        final tid = (it['media'] is Map && it['media']['customData'] is Map)
            ? it['media']['customData']['trackId'] as String?
            : null;
        if (id != null && tid != null) _itemTrack[id] = tid;
      }
    }
  }

  void setVolume(double v) {
    volume = v.clamp(0.0, 1.0);
    _ch?.command(CastChannel.nsReceiver, 'receiver-0', {
      'type': 'SET_VOLUME',
      'volume': {'level': volume},
    });
    notifyListeners();
  }

  /// Freeze the extrapolated position into the base (before a state change).
  void _rebase() {
    _posSecs = position.inMilliseconds / 1000;
    _posAt = DateTime.now().millisecondsSinceEpoch;
  }

  void _onMessage(CastMessage m) {
    if (m.namespace == CastChannel.nsReceiver && m.type == 'RECEIVER_STATUS') {
      final st = m.json['status'];
      final lvl = (st is Map && st['volume'] is Map) ? (st['volume']['level'] as num?) : null;
      if (lvl != null && (lvl.toDouble() - volume).abs() > 0.01) {
        volume = lvl.toDouble();
        notifyListeners();
      }
      // Our receiver app is gone (stopped from the TV / another sender).
      if (_transportId != null && !connecting && _findApp(m.json) == null) _handleLost();
      return;
    }
    if (m.namespace == CastChannel.nsConnection &&
        m.type == 'CLOSE' &&
        _transportId != null &&
        m.sourceId == _transportId) {
      _handleLost();
      return;
    }
    if (m.namespace != CastChannel.nsMedia) return;
    switch (m.type) {
      case 'MEDIA_STATUS':
        final list = m.json['status'] as List? ?? const [];
        if (list.isNotEmpty && list.first is Map<String, dynamic>) {
          _applyStatus(list.first as Map<String, dynamic>);
        }
      case 'LOAD_FAILED':
      case 'LOAD_CANCELLED':
      case 'INVALID_REQUEST':
        debugPrint('cast media error: ${m.json}');
        if (m.type == 'LOAD_FAILED') {
          error = 'The receiver could not play this track';
          notifyListeners();
        }
    }
  }

  void _applyStatus(Map<String, dynamic> s) {
    final wasPlaying = playing;
    _mediaSessionId = (s['mediaSessionId'] as num?)?.toInt() ?? _mediaSessionId;
    _recordItems(s['items'] as List?);
    String? tid;
    final media = s['media'];
    if (media is Map && media['customData'] is Map) {
      tid = media['customData']['trackId'] as String?;
    }
    final itemId = (s['currentItemId'] as num?)?.toInt();
    if (itemId != null) _currentItemId = itemId;
    tid ??= itemId == null ? null : _itemTrack[itemId];
    if (tid == null && itemId != null) {
      // Unknown item: ask for the full status (it carries `media`).
      _ch?.command(CastChannel.nsMedia, _transportId!, {'type': 'GET_STATUS'});
    }

    playerState = s['playerState'] as String? ?? playerState;
    idleReason = s['idleReason'] as String?;
    final t = (s['currentTime'] as num?)?.toDouble();
    if (t != null) {
      _posSecs = t;
      _posAt = DateTime.now().millisecondsSinceEpoch;
    }
    if (tid != null && tid != currentTrackId) {
      currentTrackId = tid;
      _offset = 0; // only the item we (re)loaded can start mid-track
      final k = _items.indexWhere((x) => x.trackId == tid);
      if (k > 0) _items = _items.sublist(k);
      onTrackChanged?.call(tid);
    }
    _applyGain();
    if (playerState == 'IDLE' && idleReason == 'FINISHED') {
      // Confirm after a beat: between queue items the receiver can briefly
      // report the finished item before the next one starts.
      _finishCheck?.cancel();
      _finishCheck = Timer(const Duration(milliseconds: 1500), () {
        if (playerState == 'IDLE' && idleReason == 'FINISHED') onQueueFinished?.call();
      });
    } else {
      _finishCheck?.cancel();
    }
    onStatus?.call();
    if (wasPlaying != playing) notifyListeners();
  }

  void _handleLost() {
    if (device == null) return;
    final wasActive = _transportId != null;
    _teardown();
    device = null;
    notifyListeners();
    if (wasActive) onLost?.call();
  }

  /// End the session. With [stopApp] the receiver app is closed on the device
  /// too (its playback stops); otherwise it keeps playing on its own.
  Future<void> disconnect({bool stopApp = true}) async {
    final ch = _ch;
    if (ch != null && stopApp && _sessionId != null) {
      ch.command(CastChannel.nsReceiver, 'receiver-0', {'type': 'STOP', 'sessionId': _sessionId});
    }
    await _teardown();
    device = null;
    notifyListeners();
  }

  Future<void> _teardown() async {
    _statusPoll?.cancel();
    _statusPoll = null;
    _finishCheck?.cancel();
    _finishCheck = null;
    final ch = _ch;
    _ch = null;
    _transportId = null;
    _sessionId = null;
    _mediaSessionId = null;
    currentTrackId = null;
    _currentItemId = null;
    _items = const [];
    _offset = 0;
    _gainKey = null;
    _repeatSingle = false;
    playerState = 'IDLE';
    _itemTrack.clear();
    await _sub?.cancel();
    _sub = null;
    if (ch != null) await ch.close();
  }

  @override
  void dispose() {
    _teardown();
    super.dispose();
  }
}
