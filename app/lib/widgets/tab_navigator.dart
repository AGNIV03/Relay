import 'package:flutter/material.dart';

/// A per-tab [Navigator] so detail pages (playlist/artist/album/liked) push
/// WITHIN the tab's content area, keeping the persistent chrome (bottom nav +
/// mini-player on mobile, sidebar + player bar on desktop) visible.
class TabNavigator extends StatelessWidget {
  final GlobalKey<NavigatorState> navKey;
  final WidgetBuilder rootBuilder;
  const TabNavigator({super.key, required this.navKey, required this.rootBuilder});

  @override
  Widget build(BuildContext context) {
    return Navigator(
      key: navKey,
      onGenerateRoute: (settings) => MaterialPageRoute(builder: rootBuilder),
    );
  }
}
