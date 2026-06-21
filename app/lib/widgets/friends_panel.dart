import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import 'user_profile_dialog.dart';

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
    return Column(
      children: [
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : _friends.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text('No other users yet', style: TextStyle(color: kMuted)),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: _friends.length,
                      itemBuilder: (_, i) => _FriendTile(friend: _friends[i], player: player),
                    ),
        ),
        const ChorusBar(),
      ],
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

    // Trailing actions: Join Chorus (if the friend is hosting one and we're not
    // already in a chorus), and Listen Along.
    final actions = <Widget>[];
    if (f.chorusMode != null && !player.inChorus) {
      final ask = f.chorusMode == 'ask';
      actions.add(IconButton(
        tooltip: ask ? 'Ask to join Chorus' : 'Join Chorus',
        icon: Icon(ask ? LucideIcons.users : LucideIcons.users, color: kAccent),
        onPressed: () => _joinChorus(context, f, ask),
      ));
    }
    if (isHost) {
      actions.add(IconButton(
        tooltip: 'Stop listening along',
        icon: const Icon(LucideIcons.x, color: kAccent),
        onPressed: player.stopListenAlong,
      ));
    } else if (f.online && f.track != null && !player.inChorus) {
      actions.add(IconButton(
        tooltip: 'Listen along',
        icon: const Icon(LucideIcons.headphones, color: kText),
        onPressed: () => player.startListenAlong(f.id, f.username),
      ));
    }
    final Widget? trailing =
        actions.isEmpty ? null : Row(mainAxisSize: MainAxisSize.min, children: actions);

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
      onTap: () => showUserProfileDialog(context, f.id),
    );
  }

  Future<void> _joinChorus(BuildContext context, Friend f, bool ask) async {
    final api = context.read<Api>();
    final messenger = ScaffoldMessenger.of(context);
    try {
      final status = await api.joinChorus(f.id);
      player.joinedChorus();
      messenger.showSnackBar(SnackBar(
        content: Text(status == 'requested'
            ? 'Asked to join ${f.username}’s Chorus'
            : 'Joined ${f.username}’s Chorus'),
        duration: const Duration(seconds: 2),
      ));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('Could not join')));
    }
  }
}

/// At the bottom of the friends panel: start a Chorus (when playing) or manage the
/// active one (members, requests, mode, leave).
class ChorusBar extends StatefulWidget {
  const ChorusBar({super.key});
  @override
  State<ChorusBar> createState() => _ChorusBarState();
}

class _ChorusBarState extends State<ChorusBar> {
  bool _open = true; // chosen mode before starting

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final c = player.chorus;
    if (c != null) return _active(context, player, c);
    if (player.current == null) return const SizedBox.shrink();
    return _startBar(context, player);
  }

  Widget _startBar(BuildContext context, PlayerModel player) {
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: kBorder))),
      padding: const EdgeInsets.fromLTRB(14, 8, 10, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(children: [
            Icon(LucideIcons.users, size: 16, color: kAccent),
            SizedBox(width: 8),
            Text('Start a Chorus', style: TextStyle(fontWeight: FontWeight.bold)),
          ]),
          const SizedBox(height: 2),
          const Text('Listen together — friends join and control the music.',
              style: TextStyle(color: kMuted, fontSize: 11)),
          const SizedBox(height: 8),
          Row(children: [
            _modeToggle(),
            const Spacer(),
            FilledButton(
              onPressed: () => player.startChorus(_open ? 'open' : 'ask'),
              child: const Text('Start'),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _modeToggle() {
    return Container(
      decoration: BoxDecoration(
        color: kPanel2,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        _segment('Open', _open, () => setState(() => _open = true)),
        _segment('Ask to join', !_open, () => setState(() => _open = false)),
      ]),
    );
  }

  Widget _segment(String label, bool active, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: active ? kAccent : Colors.transparent,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Text(label,
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: active ? kAccentInk : kMuted)),
        ),
      );

  Widget _active(BuildContext context, PlayerModel player, ChorusState c) {
    final api = context.read<Api>();
    return Container(
      decoration: BoxDecoration(
        color: kAccent.withValues(alpha: 0.08),
        border: const Border(top: BorderSide(color: kBorder)),
      ),
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            const Icon(LucideIcons.users, size: 16, color: kAccent),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                c.isHost ? 'Your Chorus' : '${c.hostName}’s Chorus',
                style: const TextStyle(fontWeight: FontWeight.bold, color: kAccent),
              ),
            ),
            TextButton(
              onPressed: player.leaveChorusSession,
              child: Text(c.isHost ? 'End' : 'Leave'),
            ),
          ]),
          if (c.isHost)
            Row(children: [
              const Text('Open to anyone', style: TextStyle(fontSize: 12, color: kMuted)),
              const Spacer(),
              Switch(
                value: c.mode == 'open',
                onChanged: (v) => player.setChorusMode(v ? 'open' : 'ask'),
              ),
            ]),
          // Members
          Wrap(
            spacing: 6,
            runSpacing: 2,
            children: c.members.map((m) {
              final canRemove = c.isHost && m.id != c.hostId;
              return Chip(
                visualDensity: VisualDensity.compact,
                backgroundColor: kPanel2,
                label: Text(m.id == c.hostId ? '${m.username} (host)' : m.username,
                    style: const TextStyle(fontSize: 12)),
                onDeleted: canRemove
                    ? () async {
                        await api.removeFromChorus(m.id).catchError((_) {});
                        await player.refreshChorus();
                      }
                    : null,
                deleteIcon: canRemove ? const Icon(LucideIcons.x, size: 14) : null,
              );
            }).toList(),
          ),
          // Pending requests (host only)
          if (c.isHost && c.pending.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.only(top: 4, bottom: 2),
              child: Text('Requests', style: TextStyle(fontSize: 11, color: kMuted)),
            ),
            ...c.pending.map((p) => Row(children: [
                  Expanded(child: Text(p.username, style: const TextStyle(fontSize: 13))),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    tooltip: 'Approve',
                    icon: const Icon(LucideIcons.check, size: 18, color: kAccent),
                    onPressed: () async {
                      await api.approveChorus(p.id).catchError((_) {});
                      await player.refreshChorus();
                    },
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    tooltip: 'Deny',
                    icon: const Icon(LucideIcons.x, size: 18, color: kMuted),
                    onPressed: () async {
                      await api.denyChorus(p.id).catchError((_) {});
                      await player.refreshChorus();
                    },
                  ),
                ])),
          ],
        ],
      ),
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
