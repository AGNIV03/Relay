import 'package:flutter/foundation.dart';
import 'package:media_kit/media_kit.dart';

/// Desktop-only helper for a true crossfade. just_audio drives ONE engine (the
/// queue), so the overlap needs a second, independent libmpv player: it starts
/// the next track while the main engine fades the current one out, carries the
/// audio across the track change, then hands back to the main engine (which has
/// meanwhile advanced to that track and been seeked to the same spot).
///
/// Never used on Android: its just_audio_background backend allows a single
/// player, so Android gets fade-out / fade-in instead (see PlayerModel).
class DesktopCrossfader {
  Player? _p;

  /// Track the overlap player is playing (null when idle).
  String? trackId;

  bool get active => trackId != null;
  Duration get position => _p?.state.position ?? Duration.zero;
  bool get ready => _p != null && !_p!.state.buffering && _p!.state.duration > Duration.zero;

  Future<void> start(String trackId, String uri) async {
    final p = _p ??= Player(
      configuration: const PlayerConfiguration(
        title: 'Relay',
        // Only the first few seconds are ever played; keep the cache small.
        bufferSize: 32 * 1024 * 1024,
      ),
    );
    this.trackId = trackId;
    try {
      await p.setVolume(0);
      await p.open(Media(uri), play: true);
    } catch (e) {
      debugPrint('crossfade start failed: $e');
      this.trackId = null;
    }
  }

  /// [v] in 0..1 (media_kit / mpv volume is 0..100).
  Future<void> setVolume(double v) async {
    try {
      await _p?.setVolume((v.clamp(0.0, 1.0)) * 100.0);
    } catch (_) {}
  }

  Future<void> stop() async {
    trackId = null;
    try {
      await _p?.stop();
    } catch (_) {}
  }

  Future<void> dispose() async {
    trackId = null;
    final p = _p;
    _p = null;
    try {
      await p?.dispose();
    } catch (_) {}
  }
}
