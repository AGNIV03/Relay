import 'dart:async';
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
import 'auto_browse.dart';
import 'downloads.dart';
import 'player.dart';
import 'theme.dart';
import 'screens/login_screen.dart';
import 'screens/offline_screen.dart';
import 'screens/root_screen.dart';

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Android Auto: register the media-browser callbacks SYNCHRONOUSLY, before any
  // `await` below. A cold AA launch runs main() when it binds the media-browser
  // service and queries the library almost immediately — registering here (rather
  // than after our async init, or lazily via PlayerModel) guarantees the browse
  // tree is served instead of an empty "No items". This same `api` instance is
  // populated by api.load() below, so deeper nodes resolve once the token loads.
  final api = Api(baseUrl: '');
  final browse = AutoBrowse(api);
  registerMediaBrowsing(
    getChildren: browse.getChildren,
    getMediaItem: browse.getMediaItem,
    search: browse.searchItems,
  );

  // Initialize the audio backend FIRST — before window_manager and before any
  // AudioPlayer is constructed. On desktop this registers the media_kit
  // (libmpv) platform implementation for just_audio; if it doesn't run first,
  // just_audio binds to a platform with no desktop support and nothing plays.
  try {
    if (_isDesktop) {
      // Prefetch the next playlist item (libmpv --prefetch-playlist) so tracks
      // switch near-instantly instead of stalling for seconds while the next
      // stream is opened.
      JustAudioMediaKit.prefetchPlaylist = true;
      // Buffer the ENTIRE track ahead (libmpv demuxer cache). Once a song is
      // loaded it's held in memory, so short network hiccups mid-track no longer
      // interrupt playback (YouTube/Spotify-style preload). 256MB comfortably
      // holds a full lossless/hi-res FLAC; only used on desktop (one player).
      JustAudioMediaKit.bufferSize = 256 * 1024 * 1024;
      JustAudioMediaKit.ensureInitialized(
        windows: true,
        linux: true,
        macOS: true,
      );
      debugPrint('audio backend: media_kit initialized (desktop)');
    } else {
      await JustAudioBackground.init(
        androidNotificationChannelId: 'site.agniv.stream.audio',
        androidNotificationChannelName: 'Relay playback',
        androidNotificationOngoing: true,
        androidNotificationIcon: 'drawable/ic_notification',
        // Android Auto: advertise content-style support so the head unit renders
        // browsable categories as a grid and tracks as a list.
        androidBrowsableRootExtras: const {
          'android.media.browse.CONTENT_STYLE_SUPPORTED': true,
          'android.media.browse.CONTENT_STYLE_BROWSABLE_HINT': 2,
          'android.media.browse.CONTENT_STYLE_PLAYABLE_HINT': 1,
          'android.media.browse.SEARCH_SUPPORTED': true,
        },
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

  // Load saved server URL + tokens (the `api` created above is shared with the
  // media-browser callbacks) so a cold Android Auto launch can resolve deeper
  // library nodes (Songs/Playlists/…) after the browse callbacks were registered.
  try {
    await api.load();
    debugPrint('[AA] main: api.load done base=${api.baseUrl} loggedIn=${api.isLoggedIn}');
  } catch (e) {
    debugPrint('api.load failed: $e');
  }
  final downloads = DownloadManager(api);

  try {
    await downloads.init();
  } catch (e) {
    debugPrint('downloads init failed: $e');
  }

  // Create the player EAGERLY (not lazily via Provider) so its constructor
  // re-registers browsing (incl. playFromMediaId) and restores the last session,
  // so a cold Android Auto launch shows the last-played song + can start playback.
  final player = PlayerModel(api, downloads);

  // Token + player are ready now — tell Android Auto to re-query the library and
  // the resume shelf, in case it received an empty result during the async init,
  // then keep nudging it periodically so a stale/empty cached root self-heals the
  // moment the user views Relay in the car.
  unawaited(refreshAndroidAutoBrowse());
  startAndroidAutoAutoRefresh();

  runApp(StreamApp(api: api, downloads: downloads, player: player));
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
      await trayManager.setToolTip('Relay');
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'show', label: 'Open Relay'),
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
  final PlayerModel player;
  const StreamApp(
      {super.key, required this.api, required this.downloads, required this.player});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AppState(api)..bootstrap()),
        ChangeNotifierProvider.value(value: downloads),
        // Provided as a value (created eagerly in main) so Android Auto media
        // browsing is registered even when the UI never reads PlayerModel.
        ChangeNotifierProvider.value(value: player),
        Provider.value(value: api),
      ],
      child: MaterialApp(
        title: 'Relay',
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
    // Offline: skip login entirely and let the user play their downloads. With no
    // downloads there's nothing to do offline, so show the offline-empty prompt.
    if (state.offline) {
      final downloads = context.watch<DownloadManager>();
      return downloads.hasDownloads ? const OfflineRoot() : const OfflineEmptyScreen();
    }
    return state.isLoggedIn ? const RootScreen() : const LoginScreen();
  }
}
