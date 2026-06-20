import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:just_audio_media_kit/just_audio_media_kit.dart';
import 'package:provider/provider.dart';
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

  // Desktop: keep running on window-close (minimize to taskbar like a music app).
  if (_isDesktop) {
    await windowManager.ensureInitialized();
    await windowManager.setPreventClose(true);
    windowManager.addListener(_CloseToTaskbar());
  }

  final api = Api(baseUrl: '');
  final downloads = DownloadManager(api);

  // Audio backend init must never block/crash startup.
  try {
    if (_isDesktop) {
      JustAudioMediaKit.ensureInitialized();
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

  try {
    await downloads.init();
  } catch (e) {
    debugPrint('downloads init failed: $e');
  }

  runApp(StreamApp(api: api, downloads: downloads));
}

/// On desktop, the window-close button minimizes instead of quitting so playback
/// continues (taskbar).
class _CloseToTaskbar extends WindowListener {
  @override
  void onWindowClose() async {
    await windowManager.minimize();
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
