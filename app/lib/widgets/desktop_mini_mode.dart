import 'package:flutter/material.dart';
import 'package:material_symbols_icons/symbols.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';

import '../api.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';

/// Desktop compact player: shrinks the window to a small always-on-top strip
/// (cover, title, prev / play / next) and restores the previous size, position
/// and maximized state afterwards.
class DesktopMiniMode {
  DesktopMiniMode._();

  static const size = Size(380, 104);
  static Rect? _savedBounds;
  static bool _wasMaximized = false;

  static Future<void> enter() async {
    try {
      _wasMaximized = await windowManager.isMaximized();
      if (_wasMaximized) await windowManager.unmaximize();
      _savedBounds = await windowManager.getBounds();
      await windowManager.setTitleBarStyle(TitleBarStyle.hidden, windowButtonVisibility: false);
      await windowManager.setMinimumSize(size);
      await windowManager.setResizable(false);
      await windowManager.setMaximizable(false);
      final b = _savedBounds!;
      // Keep the strip near where the window was (its top-right corner).
      await windowManager.setBounds(
          Rect.fromLTWH(b.right - size.width - 24, b.top + 24, size.width, size.height));
      await windowManager.setAlwaysOnTop(true);
    } catch (e) {
      debugPrint('mini mode enter failed: $e');
    }
  }

  static Future<void> exit() async {
    try {
      await windowManager.setAlwaysOnTop(false);
      await windowManager.setTitleBarStyle(TitleBarStyle.normal);
      await windowManager.setResizable(true);
      await windowManager.setMaximizable(true);
      await windowManager.setMinimumSize(Size.zero); // 0 = no minimum (the default)
      if (_savedBounds != null) await windowManager.setBounds(_savedBounds);
      if (_wasMaximized) await windowManager.maximize();
    } catch (e) {
      debugPrint('mini mode exit failed: $e');
    }
  }
}

/// The compact player UI shown while in mini mode. The whole strip drags the
/// window; [onRestore] goes back to the full window.
class DesktopMiniPlayer extends StatelessWidget {
  final VoidCallback onRestore;
  const DesktopMiniPlayer({super.key, required this.onRestore});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final track = player.current;
    return Material(
      color: kPanel,
      child: DragToMoveArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 10, 6, 10),
          child: Row(children: [
            if (track != null)
              Cover(url: api.trackCoverUrl(track.id), trackId: track.id, size: 64, radius: 8)
            else
              const SizedBox(width: 64, height: 64),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(track?.title ?? 'Nothing playing',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  Text(
                      player.casting
                          ? 'Casting to ${player.castDeviceName}'
                          : (track?.artistName ?? ''),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          color: player.casting ? kAccent : kMuted, fontSize: 11.5)),
                  const SizedBox(height: 4),
                  Row(children: [
                    _btn(Symbols.skip_previous, player.previous),
                    GestureDetector(
                      onTap: player.toggle,
                      child: Container(
                        width: 32,
                        height: 32,
                        decoration: const BoxDecoration(color: kAccent, shape: BoxShape.circle),
                        child: Icon(player.playing ? Symbols.pause : Symbols.play_arrow,
                            size: 18, color: kAccentInk, fill: 1),
                      ),
                    ),
                    _btn(Symbols.skip_next, player.next),
                  ]),
                ],
              ),
            ),
            Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              IconButton(
                tooltip: 'Restore window',
                iconSize: 18,
                visualDensity: VisualDensity.compact,
                icon: const Icon(Symbols.open_in_full, color: kMuted),
                onPressed: onRestore,
              ),
            ]),
          ]),
        ),
      ),
    );
  }

  Widget _btn(IconData icon, VoidCallback onTap) => IconButton(
        iconSize: 20,
        visualDensity: VisualDensity.compact,
        icon: Icon(icon, fill: 1),
        onPressed: onTap,
      );
}
