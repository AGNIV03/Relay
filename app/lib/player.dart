import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'api.dart';
import 'downloads.dart';
import 'models.dart';

/// Wraps a just_audio [AudioPlayer], exposing the current queue + playback
/// state to the UI and bridging into the OS media controls via
/// just_audio_background (Android / iOS / web).
class PlayerModel extends ChangeNotifier {
  final Api api;
  final DownloadManager downloads;
  final AudioPlayer _player = AudioPlayer();

  List<Track> _queue = [];
  int _index = 0;
  bool _scrobbled = false;

  PlayerModel(this.api, this.downloads) {
    _player.currentIndexStream.listen((i) {
      if (i != null && i != _index) {
        _index = i;
        _scrobbled = false;
        notifyListeners();
      }
    });
    _player.playerStateStream.listen((_) => notifyListeners());
    _player.positionStream.listen((pos) {
      // Scrobble a play once we're a few seconds in.
      if (!_scrobbled && pos.inSeconds >= 5 && current != null) {
        _scrobbled = true;
        api.scrobble(current!.id).catchError((_) {});
      }
      notifyListeners();
    });
  }

  AudioPlayer get raw => _player;
  List<Track> get queue => _queue;
  int get index => _index;
  Track? get current => (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  bool get playing => _player.playing;
  Duration get position => _player.position;
  Duration get duration => _player.duration ?? Duration.zero;

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
    _queue = List.of(tracks);
    _index = start;
    _scrobbled = false;
    notifyListeners();
    final source = ConcatenatingAudioSource(children: tracks.map(_sourceFor).toList());
    try {
      await _player.setAudioSource(source, initialIndex: start);
      await _player.play();
    } catch (e) {
      debugPrint('play error: $e');
    }
  }

  Future<void> toggle() async {
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
  }

  Future<void> next() => _player.seekToNext();
  Future<void> previous() async {
    if (_player.position.inSeconds > 3) {
      await _player.seek(Duration.zero);
    } else {
      await _player.seekToPrevious();
    }
  }

  Future<void> seek(Duration d) => _player.seek(d);
  Future<void> setVolume(double v) => _player.setVolume(v);
  double get volume => _player.volume;

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }
}
