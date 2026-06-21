import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';

/// A live list of all other users: avatar (green ring when online), what they're
/// playing, and a Listen Along button. Polls every ~10s.
class FriendsList extends StatefulWidget {
  const FriendsList({super.key});
  @override
  State<FriendsList> createState() => _FriendsListState();
}

class _FriendsListState extends State<FriendsList> {
  List<Friend> _friends = [];
  Timer? _timer;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => _load());
  }

  Future<void> _load() async {
    try {
      final f = await context.read<Api>().friends();
      if (!mounted) return;
      setState(() {
        _friends = f;
        _loaded = true;
      });
    } catch (_) {}
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    if (!_loaded) return const Center(child: CircularProgressIndicator());
    if (_friends.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No other users yet', style: TextStyle(color: kMuted)),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _friends.length,
      itemBuilder: (_, i) => _FriendTile(friend: _friends[i], player: player),
    );
  }
}

class _FriendTile extends StatelessWidget {
  final Friend friend;
  final PlayerModel player;
  const _FriendTile({required this.friend, required this.player});

  @override
  Widget build(BuildContext context) {
    final f = friend;
    final isHost = player.listenHostId == f.id;
    final initial = f.username.isNotEmpty ? f.username[0].toUpperCase() : '?';
    // Show the current/last track regardless of online state (never "Offline").
    final subtitle =
        f.track != null ? '${f.track!.title} • ${f.track!.artistName}' : 'No recent activity';

    // Listen-along is only offered for an online friend; keep a Stop control if
    // we're already listening with them. Offline → no button.
    Widget? trailing;
    if (isHost) {
      trailing = IconButton(
        tooltip: 'Stop listening along',
        icon: const Icon(LucideIcons.x, color: kAccent),
        onPressed: player.stopListenAlong,
      );
    } else if (f.online && f.track != null) {
      trailing = IconButton(
        tooltip: 'Listen along',
        icon: const Icon(LucideIcons.headphones, color: kText),
        onPressed: () => player.startListenAlong(f.id, f.username),
      );
    }

    return ListTile(
      leading: Container(
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(
            color: f.online ? const Color(0xFF1DB954) : Colors.transparent,
            width: 2,
          ),
        ),
        child: CircleAvatar(
          radius: 18,
          backgroundColor: kPanel2,
          child: Text(initial, style: const TextStyle(fontWeight: FontWeight.bold)),
        ),
      ),
      title: Text(f.username, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(subtitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12, color: kMuted)),
      trailing: trailing,
    );
  }
}

/// Thin bar shown above the player controls while a listen-along session is on.
class ListenAlongBar extends StatelessWidget {
  const ListenAlongBar({super.key});
  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    if (!player.listeningAlong) return const SizedBox.shrink();
    return Material(
      color: kAccent.withValues(alpha: 0.16),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        child: Row(children: [
          const Icon(LucideIcons.headphones, size: 16, color: kAccent),
          const SizedBox(width: 8),
          Expanded(
            child: Text('Listening with ${player.listenHostName}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: kAccent, fontSize: 13, fontWeight: FontWeight.w600)),
          ),
          TextButton(
            onPressed: player.stopListenAlong,
            child: const Text('Stop'),
          ),
        ]),
      ),
    );
  }
}
