import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:just_audio_media_kit/just_audio_media_kit.dart';
import 'package:provider/provider.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'api.dart';
import 'app_state.dart';
import 'downloads.dart';
import 'player.dart';
import 'theme.dart';
import 'screens/login_screen.dart';
import 'screens/root_screen.dart';

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize the audio backend FIRST — before window_manager and before any
  // AudioPlayer is constructed. On desktop this registers the media_kit
  // (libmpv) platform implementation for just_audio; if it doesn't run first,
  // just_audio binds to a platform with no desktop support and nothing plays.
  try {
    if (_isDesktop) {
      JustAudioMediaKit.ensureInitialized(
        windows: true,
        linux: true,
        macOS: true,
      );
      debugPrint('audio backend: media_kit initialized (desktop)');
    } else {
      await JustAudioBackground.init(
        androidNotificationChannelId: 'site.agniv.stream.audio',
        androidNotificationChannelName: 'Stream playback',
        androidNotificationOngoing: true,
      ).timeout(const Duration(seconds: 8));
    }
  } catch (e, st) {
    debugPrint('audio backend init failed (continuing): $e\n$st');
  }

  // Desktop: close button hides the window to the system tray (keeps playback
  // alive) instead of quitting; the app is actually closed from the tray menu.
  if (_isDesktop) {
    await windowManager.ensureInitialized();
    await windowManager.setPreventClose(true);
    await _CloseToTray.instance.setup();
  }

  final api = Api(baseUrl: '');
  final downloads = DownloadManager(api);

  try {
    await downloads.init();
  } catch (e) {
    debugPrint('downloads init failed: $e');
  }

  runApp(StreamApp(api: api, downloads: downloads));
}

/// On desktop, the window-close button hides the window into the system tray
/// (notification area / overflow chevron) instead of quitting, so playback keeps
/// going. A tray icon stays in the tray: left-click re-opens the window;
/// right-click → "Quit" actually exits the app.
class _CloseToTray with WindowListener, TrayListener {
  _CloseToTray._();
  static final instance = _CloseToTray._();

  Future<void> setup() async {
    windowManager.addListener(this);
    trayManager.addListener(this);
    try {
      await trayManager.setIcon('assets/tray_icon.ico');
      await trayManager.setToolTip('Stream');
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'show', label: 'Open Stream'),
        MenuItem.separator(),
        MenuItem(key: 'quit', label: 'Quit'),
      ]));
    } catch (e) {
      debugPrint('[tray] setup failed: $e');
    }
  }

  Future<void> _restore() async {
    await windowManager.show();
    await windowManager.focus();
  }

  // Close button -> hide to tray. Hiding the window (SW_HIDE) already removes its
  // taskbar button, leaving only the tray icon.
  @override
  void onWindowClose() async {
    debugPrint('[tray] onWindowClose -> hide');
    try {
      await windowManager.hide();
    } catch (e) {
      debugPrint('[tray] hide failed: $e');
    }
  }

  // Left-click the tray icon -> bring the window back.
  @override
  void onTrayIconMouseDown() => _restore();

  // Right-click the tray icon -> show the Open/Quit menu. bringAppToFront makes
  // our (hidden) window the foreground owner so the menu dismisses on an
  // outside click instead of sticking (Win32 TrackPopupMenu quirk).
  @override
  void onTrayIconRightMouseDown() =>
      trayManager.popUpContextMenu(bringAppToFront: true);

  @override
  void onTrayMenuItemClick(MenuItem menuItem) async {
    if (menuItem.key == 'show') {
      await _restore();
    } else if (menuItem.key == 'quit') {
      await trayManager.destroy();
      await windowManager.setPreventClose(false);
      await windowManager.destroy();
    }
  }
}

class StreamApp extends StatelessWidget {
  final Api api;
  final DownloadManager downloads;
  const StreamApp({super.key, required this.api, required this.downloads});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AppState(api)..bootstrap()),
        ChangeNotifierProvider.value(value: downloads),
        ChangeNotifierProvider(create: (_) => PlayerModel(api, downloads)),
        Provider.value(value: api),
      ],
      child: MaterialApp(
        title: 'Stream',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: const _Gate(),
      ),
    );
  }
}

class _Gate extends StatelessWidget {
  const _Gate();
  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    if (state.loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return state.isLoggedIn ? const RootScreen() : const LoginScreen();
  }
}
