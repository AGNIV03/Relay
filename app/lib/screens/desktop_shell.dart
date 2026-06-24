import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:just_audio/just_audio.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../events.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/friends_panel.dart';
import '../widgets/like_button.dart';
import '../widgets/squiggly_progress.dart';
import '../widgets/tab_navigator.dart';
import 'home_screen.dart';
import 'songs_screen.dart';
import 'artists_screen.dart';
import 'playlists_screen.dart';
import 'liked_songs_screen.dart';
import '../widgets/lyrics_pane.dart';
import 'playlist_detail_screen.dart';
import 'profile_screen.dart';
import 'now_playing_screen.dart';
import 'queue_screen.dart';

/// Web-style desktop layout: left sidebar nav + content area + a full-width
/// player bar pinned at the bottom. (Mobile keeps the bottom-nav layout.)
class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key});
  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  int _index = 0;
  // Which right-side panel is open (web-style): 'friends' | 'queue' | ''.
  String _rightPanel = 'friends';
  // Lyrics overlay the MIDDLE content area (they need the width/height), separate
  // from the right-side panels.
  bool _showLyrics = false;
  final List<GlobalKey<NavigatorState>> _navKeys =
      List.generate(4, (_) => GlobalKey<NavigatorState>());
  // The open profile route, so the profile button doesn't stack duplicates.
  Route<dynamic>? _profileRoute;

  void _toggleRight(String name) =>
      setState(() => _rightPanel = _rightPanel == name ? '' : name);

  /// Lyrics overlay shown over the middle content area (full width/height).
  Widget _lyricsOverlay() {
    return Material(
      color: kBg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Consumer<PlayerModel>(
            builder: (_, player, _) => Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 8, 8),
              child: Row(children: [
                Expanded(
                  child: Text(
                      player.current == null ? 'Lyrics' : '${player.current!.title} — Lyrics',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                ),
                IconButton(
                  icon: const Icon(LucideIcons.x, size: 18),
                  onPressed: () => setState(() => _showLyrics = false),
                ),
              ]),
            ),
          ),
          Expanded(
            child: Consumer<PlayerModel>(
              builder: (_, player, _) => player.current == null
                  ? const Center(child: Text('Nothing playing', style: TextStyle(color: kMuted)))
                  : LyricsPane(player: player),
            ),
          ),
        ],
      ),
    );
  }

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

  /// Open the profile page, idempotently — clicking Profile again while it's
  /// already showing does nothing (instead of stacking duplicate profile pages).
  void _openProfile() {
    final nav = _navKeys[_index].currentState;
    if (nav == null) return;
    if (_profileRoute != null && _profileRoute!.isCurrent) return;
    final route = MaterialPageRoute<void>(builder: (_) => const _ProfilePage());
    _profileRoute = route;
    nav.push(route).then((_) {
      if (_profileRoute == route) _profileRoute = null;
    });
  }

  /// The right-side panel (queue / lyrics / friends), web-style. Returns an empty
  /// box when nothing is open.
  Widget _rightPanelArea() {
    String title;
    Widget body;
    switch (_rightPanel) {
      case 'queue':
        title = 'Queue';
        body = const QueuePanel();
      case 'friends':
        title = 'Friend activity';
        body = const FriendsList();
      default:
        return const SizedBox.shrink();
    }
    return Container(
      width: 320,
      decoration: const BoxDecoration(
        color: kPanel,
        border: Border(left: BorderSide(color: kBorder)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
            child: Row(children: [
              Expanded(
                child: Text(title,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              ),
              IconButton(
                icon: const Icon(LucideIcons.x, size: 18),
                onPressed: () => setState(() => _rightPanel = ''),
              ),
            ]),
          ),
          Expanded(child: body),
        ],
      ),
    );
  }

  /// True when a text field (search box, etc.) currently has focus, so the
  /// keyboard shortcuts below don't hijack Space / arrows while the user types.
  bool _isTyping() {
    final ctx = FocusManager.instance.primaryFocus?.context;
    return ctx != null && ctx.findAncestorStateOfType<EditableTextState>() != null;
  }

  /// App-level media shortcuts (desktop). Key events bubble up to this root
  /// [Focus]; text fields consume their own keys first, and we also bail out
  /// while typing. Repeats are allowed for volume/seek (hold to ramp) but not
  /// for play/pause and track skip.
  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is KeyUpEvent) return KeyEventResult.ignored;
    if (_isTyping()) return KeyEventResult.ignored;
    final repeat = e is KeyRepeatEvent;
    final player = context.read<PlayerModel>();
    final k = e.logicalKey;
    if (k == LogicalKeyboardKey.space) {
      if (!repeat) player.toggle();
    } else if (k == LogicalKeyboardKey.arrowUp) {
      player.nudgeVolume(0.05);
    } else if (k == LogicalKeyboardKey.arrowDown) {
      player.nudgeVolume(-0.05);
    } else if (k == LogicalKeyboardKey.arrowRight) {
      player.nudgeSeek(const Duration(seconds: 10));
    } else if (k == LogicalKeyboardKey.arrowLeft) {
      player.nudgeSeek(const Duration(seconds: -10));
    } else if (k == LogicalKeyboardKey.bracketLeft) {
      if (!repeat) player.previous();
    } else if (k == LogicalKeyboardKey.bracketRight) {
      if (!repeat) player.next();
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    const pages = [HomeScreen(), SongsScreen(), ArtistsScreen(), PlaylistsScreen()];
    return Focus(
      autofocus: true,
      onKeyEvent: _onKey,
      child: Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Sidebar(
            index: _index,
            onSelect: (i) => setState(() => _index = i),
            onOpen: _openInTab,
            onOpenProfile: _openProfile,
          ),
          Expanded(
            child: Stack(
              children: [
                IndexedStack(
                  index: _index,
                  children: [
                    for (var i = 0; i < 4; i++)
                      TabNavigator(navKey: _navKeys[i], rootBuilder: (_) => pages[i]),
                  ],
                ),
                if (_showLyrics) Positioned.fill(child: _lyricsOverlay()),
              ],
            ),
          ),
          _rightPanelArea(),
        ],
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const ListenAlongBar(),
          _DesktopPlayerBar(
            activePanel: _rightPanel,
            onTogglePanel: _toggleRight,
            lyricsOpen: _showLyrics,
            onToggleLyrics: () => setState(() => _showLyrics = !_showLyrics),
          ),
        ],
      ),
      ),
    );
  }
}

class _Sidebar extends StatefulWidget {
  final int index;
  final ValueChanged<int> onSelect;
  final ValueChanged<Widget> onOpen;
  final VoidCallback onOpenProfile;
  const _Sidebar(
      {required this.index,
      required this.onSelect,
      required this.onOpen,
      required this.onOpenProfile});
  @override
  State<_Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<_Sidebar> {
  List<Playlist> _playlists = [];

  @override
  void initState() {
    super.initState();
    _loadPlaylists();
    playlistsChanged.addListener(_loadPlaylists); // refresh on create/delete/rename
  }

  @override
  void dispose() {
    playlistsChanged.removeListener(_loadPlaylists);
    super.dispose();
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
            child: Text('The ultimate music hosting solution',
                style: TextStyle(color: kMuted, fontSize: 11)),
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
            leading: const Icon(LucideIcons.user, size: 18),
            title: Text(context.watch<AppState>().user?.username ?? 'Profile',
                style: const TextStyle(fontSize: 13)),
            subtitle: const Text('Profile', style: TextStyle(fontSize: 11, color: kMuted)),
            onTap: widget.onOpenProfile,
          ),
        ],
      ),
    );
  }
}

/// Desktop profile page (pushed from the sidebar corner button).
class _ProfilePage extends StatelessWidget {
  const _ProfilePage();
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: const ProfileScreen(showFriends: false),
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
  final String activePanel; // 'friends' | 'queue' | ''
  final void Function(String) onTogglePanel;
  final bool lyricsOpen;
  final VoidCallback onToggleLyrics;
  const _DesktopPlayerBar({
    required this.activePanel,
    required this.onTogglePanel,
    required this.lyricsOpen,
    required this.onToggleLyrics,
  });

  String _fmt(Duration d) => "${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}";

  /// Quality line from metadata, e.g. "FLAC · 1058 kbps" or "MP3 · 320 kbps".
  String? _quality(Track t) {
    final parts = <String>[];
    if (t.format != null && t.format!.trim().isNotEmpty) parts.add(t.format!.toUpperCase());
    if (t.bitrate != null && t.bitrate! > 0) {
      // music-metadata reports bitrate in bits/sec.
      final kbps = t.bitrate! >= 2000 ? (t.bitrate! / 1000).round() : t.bitrate!;
      parts.add('$kbps kbps');
    }
    return parts.isEmpty ? null : parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final track = player.current;
    // Mouse wheel over the player bar adjusts volume (scoped here so scrolling
    // the song lists elsewhere keeps scrolling, not changing volume).
    return Listener(
      onPointerSignal: (signal) {
        if (signal is PointerScrollEvent) {
          player.nudgeVolume(signal.scrollDelta.dy < 0 ? 0.05 : -0.05);
        }
      },
      child: Container(
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
                    // Flexible (not Expanded) so the heart sits right next to the
                    // song name instead of being pushed to the far right.
                    Flexible(
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
                          if (_quality(track) != null)
                            Text(_quality(track)!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    color: kMuted.withValues(alpha: 0.7),
                                    fontSize: 10,
                                    letterSpacing: 0.3)),
                        ],
                      ),
                    ),
                    const SizedBox(width: 6),
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
                      tooltip: 'Friend activity',
                      iconSize: 19,
                      icon: Icon(LucideIcons.users,
                          color: activePanel == 'friends' ? kAccent : kMuted),
                      onPressed: () => onTogglePanel('friends'),
                    ),
                    IconButton(
                      tooltip: 'Queue',
                      iconSize: 19,
                      icon: Icon(LucideIcons.listMusic,
                          color: activePanel == 'queue' ? kAccent : kMuted),
                      onPressed: () => onTogglePanel('queue'),
                    ),
                    IconButton(
                      tooltip: 'Lyrics',
                      iconSize: 19,
                      icon: Icon(LucideIcons.lyrics, color: lyricsOpen ? kAccent : kMuted),
                      onPressed: onToggleLyrics,
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
      ),
    );
  }
}
