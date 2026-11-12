import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'player.dart';

/// Windows System Media Transport Controls: keyboard media keys (even while the
/// window is hidden in the tray) and the Windows "now playing" flyout. The
/// media_kit (libmpv) backend doesn't register an SMTC session itself, so the
/// runner exposes one (windows/runner/smtc_plugin.cpp) and this mirrors the
/// player into it.
class WindowsSmtc {
  WindowsSmtc._();
  static const _ch = MethodChannel('relay/smtc');
  static bool _attached = false;

  static void attach(PlayerModel player, Api api) {
    if (kIsWeb || !Platform.isWindows || _attached) return;
    _attached = true;

    _ch.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'button':
          switch (call.arguments) {
            case 'play':
              if (!player.playing) await player.toggle();
            case 'pause' || 'stop':
              if (player.playing) await player.toggle();
            case 'next':
              await player.next();
            case 'previous':
              await player.previous();
          }
        case 'seek':
          final ms = call.arguments;
          if (ms is int) await player.seek(Duration(milliseconds: ms));
      }
      return null;
    });

    String? trackSig;
    bool? playing;
    void sync() {
      final t = player.current;
      if (t == null) {
        if (trackSig != null) {
          trackSig = null;
          playing = null;
          _call('clear');
        }
        return;
      }
      final sig = '${t.id}|${player.castDeviceName ?? ''}';
      if (sig != trackSig) {
        trackSig = sig;
        _call('metadata', {
          'title': t.title,
          'artist': player.casting ? '${t.artistName} (casting to ${player.castDeviceName})' : t.artistName,
          'album': t.albumTitle,
          'artUrl': api.trackCoverUrl(t.id),
          'artPath': player.downloads.localCoverPath(t.id) ?? '',
        });
        _timeline(player);
      }
      if (player.playing != playing) {
        playing = player.playing;
        _call('state', {'playing': playing});
        _timeline(player);
      }
    }

    player.addListener(sync);
    // Keep the flyout's progress roughly current without per-tick traffic.
    Timer.periodic(const Duration(seconds: 5), (_) {
      if (player.current != null && player.playing) _timeline(player);
    });
    sync();
  }

  static void _timeline(PlayerModel p) => _call('timeline', {
        'positionMs': p.position.inMilliseconds,
        'durationMs': p.duration.inMilliseconds,
      });

  static void _call(String method, [Object? args]) {
    _ch.invokeMethod<void>(method, args).catchError((Object e) {
      debugPrint('smtc $method failed: $e');
    });
  }
}
