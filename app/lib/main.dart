import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:just_audio_media_kit/just_audio_media_kit.dart';
import 'package:provider/provider.dart';

import 'api.dart';
import 'app_state.dart';
import 'downloads.dart';
import 'player.dart';
import 'theme.dart';
import 'screens/login_screen.dart';
import 'screens/root_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final api = Api(baseUrl: '');
  final downloads = DownloadManager(api);

  // Audio backend init must NEVER block or crash app startup (a throw/hang here
  // would leave the user staring at a black screen). Wrap it defensively.
  try {
    final isWinOrLinux = !kIsWeb && (Platform.isWindows || Platform.isLinux);
    if (isWinOrLinux) {
      JustAudioMediaKit.ensureInitialized();
    } else {
      await JustAudioBackground.init(
        androidNotificationChannelId: 'eco.regenesis.stream.audio',
        androidNotificationChannelName: 'Stream playback',
        androidNotificationOngoing: true,
      ).timeout(const Duration(seconds: 8));
    }
  } catch (e, st) {
    debugPrint('audio backend init failed (continuing without it): $e\n$st');
  }

  try {
    await downloads.init();
  } catch (e) {
    debugPrint('downloads init failed (continuing): $e');
  }

  runApp(StreamApp(api: api, downloads: downloads));
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
