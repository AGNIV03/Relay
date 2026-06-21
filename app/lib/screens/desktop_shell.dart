import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/like_button.dart';
import '../widgets/squiggly_progress.dart';
import '../widgets/tab_navigator.dart';
import 'home_screen.dart';
import 'songs_screen.dart';
import 'artists_screen.dart';
import 'playlists_screen.dart';
import 'liked_songs_screen.dart';
import 'lyrics_screen.dart';
import 'playlist_detail_screen.dart';
import 'now_playing_screen.dart';

/// Web-style desktop layout: left sidebar nav + content area + a full-width
/// player bar pinned at the bottom. (Mobile keeps the bottom-nav layout.)
class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key});
  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  int _index = 0;
  final List<GlobalKey<NavigatorState>> _navKeys =
      List.generate(4, (_) => GlobalKey<NavigatorState>());
  // The open lyrics route per tab, so the lyrics button toggles instead of
  // stacking duplicate lyrics pages.
  final List<Route<dynamic>?> _lyricsRoutes = List.filled(4, null);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<PlayerModel>().restoreSession();
    });
  }

  /// Open a detail page (playlist / liked) from the sidebar. Always shows it in
  /// the Playlists tab and REPLACES any page already open there, so opening one
  /// playlist after another doesn't stack — Back returns to the Playlists grid.
  void _openInTab(Widget page) {
    const playlistsTab = 3;
    if (_index != playlistsTab) setState(() => _index = playlistsTab);
    final nav = _navKeys[playlistsTab].currentState;
    nav?.popUntil((r) => r.isFirst);
    nav?.push(MaterialPageRoute(builder: (_) => page));
  }

  /// Toggle the lyrics page in the active tab: open it if closed, close it if
  /// it's currently showing (so the note button doesn't stack duplicates).
  void _toggleLyrics() {
    final i = _index;
    final nav = _navKeys[i].currentState;
    if (nav == null) return;
    final open = _lyricsRoutes[i];
    if (open != null && open.isCurrent) {
      nav.pop();
      _lyricsRoutes[i] = null;
    } else {
      final route = MaterialPageRoute<void>(builder: (_) => const LyricsScreen());
      _lyricsRoutes[i] = route;
      nav.push(route).then((_) {
        if (_lyricsRoutes[i] == route) _lyricsRoutes[i] = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    const pages = [HomeScreen(), SongsScreen(), ArtistsScreen(), PlaylistsScreen()];
    return Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Sidebar(
            index: _index,
            onSelect: (i) => setState(() => _index = i),
            onOpen: _openInTab,
          ),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: [
                for (var i = 0; i < 4; i++)
                  TabNavigator(navKey: _navKeys[i], rootBuilder: (_) => pages[i]),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: _DesktopPlayerBar(
        onOpenLyrics: _toggleLyrics,
      ),
    );
  }
}

class _Sidebar extends StatefulWidget {
  final int index;
  final ValueChanged<int> onSelect;
  final ValueChanged<Widget> onOpen;
  const _Sidebar({required this.index, required this.onSelect, required this.onOpen});
  @override
  State<_Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<_Sidebar> {
  List<Playlist> _playlists = [];

  @override
  void initState() {
    super.initState();
    _loadPlaylists();
  }

  Future<void> _loadPlaylists() async {
    try {
      final pls = await context.read<Api>().playlists();
      if (mounted) setState(() => _playlists = pls);
    } catch (_) {}
  }

  static const _nav = [
    (LucideIcons.home, 'Home'),
    (LucideIcons.music2, 'Songs'),
    (LucideIcons.mic2, 'Artists'),
    (LucideIcons.listMusic, 'Playlists'),
  ];

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 240,
      color: kPanel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 22, 20, 4),
            child: Row(children: [
              Image(image: AssetImage('assets/logo.png'), width: 26, height: 26),
              SizedBox(width: 8),
              Text('Relay', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ]),
          ),
          const Padding(
            padding: EdgeInsets.only(left: 20, bottom: 10),
            child: Text('self-hosted music', style: TextStyle(color: kMuted, fontSize: 11)),
          ),
          for (var i = 0; i < _nav.length; i++)
            _NavItem(
              icon: _nav[i].$1,
              label: _nav[i].$2,
              active: widget.index == i,
              onTap: () => widget.onSelect(i),
            ),
          const Divider(height: 18, indent: 16, endIndent: 16),
          _NavItem(
            icon: LucideIcons.heart,
            label: 'Liked Songs',
            iconColor: kAccent,
            filled: true,
            onTap: () => widget.onOpen(const LikedSongsScreen()),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.only(top: 4),
              children: [
                for (final pl in _playlists)
                  ListTile(
                    dense: true,
                    visualDensity: VisualDensity.compact,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                    horizontalTitleGap: 10,
                    leading: Cover(
                      url: context.read<Api>().playlistCoverUrl(pl.id),
                      size: 36,
                      radius: 6,
                    ),
                    title: Text(pl.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13, color: kMuted)),
                    onTap: () =>
                        widget.onOpen(PlaylistDetailScreen(playlistId: pl.id, name: pl.name)),
                  ),
              ],
            ),
          ),
          const Divider(height: 1),
          ListTile(
            leading: const Icon(LucideIcons.logOut, size: 18),
            title: Text(context.watch<AppState>().user?.username ?? 'Sign out',
                style: const TextStyle(fontSize: 13)),
            onTap: () => context.read<AppState>().logout(),
          ),
        ],
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;
  final bool filled;
  final Color? iconColor;
  final VoidCallback onTap;
  const _NavItem({
    required this.icon,
    required this.label,
    required this.onTap,
    this.active = false,
    this.filled = false,
    this.iconColor,
  });
  @override
  Widget build(BuildContext context) {
    return Material(
      color: active ? kPanel2 : Colors.transparent,
      child: ListTile(
        dense: true,
        leading: Icon(icon, size: 19, fill: filled ? 1 : 0, color: iconColor ?? (active ? kText : kMuted)),
        title: Text(label,
            style: TextStyle(
                fontSize: 14,
                color: active ? kText : kMuted,
                fontWeight: active ? FontWeight.w600 : FontWeight.w400)),
        onTap: onTap,
      ),
    );
  }
}

class _DesktopPlayerBar extends StatelessWidget {
  final VoidCallback onOpenLyrics;
  const _DesktopPlayerBar({required this.onOpenLyrics});

  String _fmt(Duration d) => "${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}";

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final track = player.current;
    return Container(
      height: 84,
      decoration: const BoxDecoration(
        color: kPanel,
        border: Border(top: BorderSide(color: kBorder)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: track == null
          ? const Center(
              child: Text('Pick a track to start playing', style: TextStyle(color: kMuted)))
          : Row(
              children: [
                // Now playing
                Expanded(
                  flex: 3,
                  child: Row(children: [
                    GestureDetector(
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => const NowPlayingScreen()),
                      ),
                      child: Cover(url: api.trackCoverUrl(track.id), size: 52, radius: 8),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(track.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                          Text(track.artistName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(color: kMuted, fontSize: 12)),
                        ],
                      ),
                    ),
                    LikeButton(trackId: track.id, size: 20),
                  ]),
                ),
                // Controls + seek
                Expanded(
                  flex: 4,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        IconButton(
                          iconSize: 20,
                          icon: Icon(LucideIcons.shuffle,
                              color: player.shuffleEnabled ? kAccent : kMuted),
                          onPressed: player.toggleShuffle,
                        ),
                        IconButton(iconSize: 22, icon: const Icon(LucideIcons.skipBack), onPressed: player.previous),
                        GestureDetector(
                          onTap: player.toggle,
                          child: Container(
                            width: 40,
                            height: 40,
                            decoration: const BoxDecoration(color: kAccent, shape: BoxShape.circle),
                            child: Icon(player.playing ? LucideIcons.pause : LucideIcons.play,
                                size: 20, color: kAccentInk),
                          ),
                        ),
                        IconButton(iconSize: 22, icon: const Icon(LucideIcons.skipForward), onPressed: player.next),
                        IconButton(
                          iconSize: 20,
                          icon: Icon(
                            player.loopMode == LoopMode.one ? LucideIcons.repeatOne : LucideIcons.repeat,
                            color: player.loopMode == LoopMode.off ? kMuted : kAccent,
                          ),
                          onPressed: player.cycleRepeat,
                        ),
                      ]),
                      Row(children: [
                        Text(_fmt(player.position),
                            style: const TextStyle(color: kMuted, fontSize: 11)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: SquigglyProgress(
                            position: player.position,
                            duration: player.duration,
                            playing: player.playing,
                            onSeek: player.seek,
                            height: 22,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(_fmt(player.duration),
                            style: const TextStyle(color: kMuted, fontSize: 11)),
                      ]),
                    ],
                  ),
                ),
                // Lyrics + volume
                Expanded(
                  flex: 3,
                  child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                    IconButton(
                      tooltip: 'Lyrics',
                      iconSize: 19,
                      icon: const Icon(LucideIcons.lyrics, color: kMuted),
                      onPressed: onOpenLyrics,
                    ),
                    const SizedBox(width: 4),
                    const Icon(LucideIcons.volume2, size: 18, color: kMuted),
                    SizedBox(
                      width: 120,
                      child: Slider(
                        value: player.volume.clamp(0.0, 1.0),
                        onChanged: player.setVolume,
                      ),
                    ),
                  ]),
                ),
              ],
            ),
    );
  }
}
