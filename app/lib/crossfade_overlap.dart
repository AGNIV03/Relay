import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart' as ja;
import 'package:media_kit/media_kit.dart';

/// The second, independent player behind a true crossfade. just_audio drives
/// ONE engine (the queue), so the overlap needs another player: it starts the
/// next track while the main engine fades the current one out, carries the
/// audio across the track change, then hands back to the main engine (which has
/// meanwhile advanced to that track and been seeked to the same spot).
abstract class CrossfadeOverlap {
  /// The overlap player for this platform, or null where there is none (web).
  static CrossfadeOverlap? forPlatform() {
    if (kIsWeb) return null;
    if (Platform.isAndroid) return AndroidCrossfader();
    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) return DesktopCrossfader();
    return null;
  }

  /// Track the overlap player is playing (null when idle).
  String? get trackId;
  bool get active => trackId != null;
  Duration get position;

  /// Start [trackId] from [source] (a URL or a local file path) silently.
  Future<void> start(String trackId, String source);

  /// [v] in 0..1.
  Future<void> setVolume(double v);
  Future<void> stop();
  Future<void> dispose();
}

/// Desktop: a libmpv (media_kit) player alongside just_audio_media_kit's own.
class DesktopCrossfader extends CrossfadeOverlap {
  Player? _p;
  @override
  String? trackId;

  @override
  Duration get position => _p?.state.position ?? Duration.zero;

  @override
  Future<void> start(String trackId, String source) async {
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
      await p.open(Media(source), play: true);
    } catch (e) {
      debugPrint('crossfade start failed: $e');
      this.trackId = null;
    }
  }

  /// media_kit / mpv volume is 0..100.
  @override
  Future<void> setVolume(double v) async {
    try {
      await _p?.setVolume((v.clamp(0.0, 1.0)) * 100.0);
    } catch (_) {}
  }

  @override
  Future<void> stop() async {
    trackId = null;
    try {
      await _p?.stop();
    } catch (_) {}
  }

  @override
  Future<void> dispose() async {
    trackId = null;
    final p = _p;
    _p = null;
    try {
      await p?.dispose();
    } catch (_) {}
  }
}

/// Android: a second just_audio player. Our just_audio_background fork runs any
/// player created after the main one as a plain ExoPlayer (no media session,
/// notification or queue), which is all the few-second overlap needs. The main
/// player's foreground service keeps the process alive in the background.
class AndroidCrossfader extends CrossfadeOverlap {
  ja.AudioPlayer? _p;
  @override
  String? trackId;

  @override
  Duration get position => _p?.position ?? Duration.zero;

  @override
  Future<void> start(String trackId, String source) async {
    // The main player owns audio focus and interruption handling; the overlap
    // is stopped whenever the main one pauses (see PlayerModel._abortCrossfade).
    final p = _p ??= ja.AudioPlayer(
      handleInterruptions: false,
      handleAudioSessionActivation: false,
    );
    this.trackId = trackId;
    try {
      await p.setVolume(0);
      final uri = source.contains('://') ? Uri.parse(source) : Uri.file(source);
      await p.setAudioSource(ja.AudioSource.uri(uri), preload: true);
      if (this.trackId != trackId) return; // stopped while loading
      p.play(); // completes only when playback stops; don't await
    } catch (e) {
      debugPrint('crossfade start failed: $e');
      if (this.trackId == trackId) this.trackId = null;
    }
  }

  @override
  Future<void> setVolume(double v) async {
    try {
      await _p?.setVolume(v.clamp(0.0, 1.0));
    } catch (_) {}
  }

  @override
  Future<void> stop() async {
    trackId = null;
    try {
      await _p?.stop();
    } catch (_) {}
  }

  @override
  Future<void> dispose() async {
    trackId = null;
    final p = _p;
    _p = null;
    try {
      await p?.dispose();
    } catch (_) {}
  }
}
