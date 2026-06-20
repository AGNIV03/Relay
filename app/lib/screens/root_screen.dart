import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../app_state.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import 'desktop_shell.dart';
import 'home_screen.dart';
import 'songs_screen.dart';
import 'artists_screen.dart';
import 'playlists_screen.dart';

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

class RootScreen extends StatelessWidget {
  const RootScreen({super.key});
  @override
  Widget build(BuildContext context) {
    // Desktop gets the web-style sidebar layout; mobile keeps the bottom nav.
    return _isDesktop ? const DesktopShell() : const _MobileRoot();
  }
}

class _MobileRoot extends StatefulWidget {
  const _MobileRoot();
  @override
  State<_MobileRoot> createState() => _RootScreenState();
}

class _RootScreenState extends State<_MobileRoot> {
  int _index = 0;
  static const _titles = ["Home", "Songs", "Artists", "Playlists"];

  @override
  void initState() {
    super.initState();
    // Resume whatever was playing when the app was last closed (paused).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<PlayerModel>().restoreSession();
    });
  }

  @override
  Widget build(BuildContext context) {
    const pages = [HomeScreen(), SongsScreen(), ArtistsScreen(), PlaylistsScreen()];
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_index]),
        actions: [
          IconButton(
            icon: const Icon(LucideIcons.logOut, size: 20),
            tooltip: "Sign out",
            onPressed: () => context.read<AppState>().logout(),
          ),
        ],
      ),
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const MiniPlayer(),
          NavigationBar(
            height: 64,
            backgroundColor: kPanel,
            selectedIndex: _index,
            onDestinationSelected: (i) => setState(() => _index = i),
            destinations: const [
              NavigationDestination(icon: Icon(LucideIcons.home), label: "Home"),
              NavigationDestination(icon: Icon(LucideIcons.music2), label: "Songs"),
              NavigationDestination(icon: Icon(LucideIcons.mic2), label: "Artists"),
              NavigationDestination(icon: Icon(LucideIcons.listMusic), label: "Playlists"),
            ],
          ),
        ],
      ),
    );
  }
}
