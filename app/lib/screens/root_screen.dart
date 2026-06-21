import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import '../widgets/tab_navigator.dart';
import 'desktop_shell.dart';
import 'home_screen.dart';
import 'songs_screen.dart';
import 'playlists_screen.dart';
import 'profile_screen.dart';

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
  static const _titles = ["Home", "Songs", "Playlists", "Profile"];
  final List<GlobalKey<NavigatorState>> _navKeys =
      List.generate(4, (_) => GlobalKey<NavigatorState>());

  @override
  void initState() {
    super.initState();
    // Resume whatever was playing when the app was last closed (paused).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<PlayerModel>().restoreSession();
    });
  }

  // Each tab's root page, wrapped in a Scaffold with its own app bar. Detail
  // pages push on top of this WITHIN the tab navigator, so the bottom nav +
  // mini-player below stay visible.
  Widget _tabRoot(int i) {
    const pages = [HomeScreen(), SongsScreen(), PlaylistsScreen(), ProfileScreen()];
    return Scaffold(
      appBar: AppBar(title: Text(_titles[i])),
      body: pages[i],
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        final nav = _navKeys[_index].currentState;
        if (nav != null && nav.canPop()) nav.pop();
      },
      child: Scaffold(
        body: IndexedStack(
          index: _index,
          children: [
            for (var i = 0; i < 4; i++)
              TabNavigator(navKey: _navKeys[i], rootBuilder: (_) => _tabRoot(i)),
          ],
        ),
        bottomNavigationBar: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const MiniPlayer(),
            NavigationBar(
              height: 64,
              backgroundColor: kPanel,
              selectedIndex: _index,
              onDestinationSelected: (i) {
                // Re-tapping the active tab pops it back to its root.
                if (i == _index) {
                  _navKeys[i].currentState?.popUntil((r) => r.isFirst);
                } else {
                  setState(() => _index = i);
                }
              },
              destinations: const [
                NavigationDestination(icon: Icon(LucideIcons.home), label: "Home"),
                NavigationDestination(icon: Icon(LucideIcons.music2), label: "Songs"),
                NavigationDestination(icon: Icon(LucideIcons.listMusic), label: "Playlists"),
                NavigationDestination(icon: Icon(LucideIcons.user), label: "Profile"),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
