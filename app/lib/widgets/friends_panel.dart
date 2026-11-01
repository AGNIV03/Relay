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

  String _friendsSig = '';

  Future<void> _load() async {
    try {
      final f = await context.read<Api>().friends();
      if (!mounted) return;
      // Polled every 10s; skip the rebuild when nothing visible changed.
      final sig = f
          .map((x) => '${x.id}|${x.online}|${x.playing}|${x.track?.id}|${x.chorusMode}|'
              '${x.inChorusWithYou}|${x.listeningToYou}|${x.isPrivate}|${x.allowListenAlong}')
          .join(';');
      if (_loaded && sig == _friendsSig) return;
      _friendsSig = sig;
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
    // Per-viewer relationship status takes priority over the now-playing line.
    final status = f.inChorusWithYou
        ? 'In a chorus with you'
        : f.listeningToYou
            ? 'Listening along with you'
            : null;
    // Show the current/last track regardless of online state (never "Offline").
    final subtitle = f.isPrivate
        ? 'Activity is private'
        : f.track != null
            ? '${f.track!.title} • ${f.track!.artistName}'
            : 'No recent activity';

    // Trailing actions: Join Chorus (when the friend is hosting and we aren't
    // already a member of someone's chorus), and Listen Along. With auto-start
    // most users are always hosting their own chorus, so we gate on *member*
    // status, not "in a chorus" — joining/following ends our own auto-chorus.
    final actions = <Widget>[];
    final canJoin =
        f.chorusMode != null && player.chorus?.hostId != f.id && !player.isChorusMember;
    if (canJoin) {
      final ask = f.chorusMode == 'ask';
      actions.add(IconButton(
        tooltip: ask ? 'Ask to join Chorus' : 'Join Chorus',
        icon: Icon(ask ? LucideIcons.userPlus : LucideIcons.radio, color: kAccent),
        onPressed: () => _joinChorus(context, f, ask),
      ));
    }
    if (isHost) {
      actions.add(IconButton(
        tooltip: 'Stop listening along',
        icon: const Icon(LucideIcons.x, color: kAccent),
        onPressed: player.stopListenAlong,
      ));
    } else if (f.online && f.track != null && f.allowListenAlong && !player.isChorusMember) {
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
      subtitle: status != null
          ? Row(children: [
              const Icon(LucideIcons.radio, size: 12, color: kAccent),
              const SizedBox(width: 4),
              Expanded(
                child: Text(status,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12, color: kAccent, fontWeight: FontWeight.w600)),
              ),
            ])
          : Text(subtitle,
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
  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final c = player.chorus;
    if (c == null && player.current == null) return const SizedBox.shrink();

    final active = c != null && !c.isPending;
    final pending = c != null && c.isPending;
    final isHost = c?.isHost ?? false;
    final on = active || pending;

    // The toggle next to "Chorus" turns it on/off: off ends (host) / leaves
    // (member) / cancels (pending); on starts a new open chorus.
    void toggle() {
      if (c != null) {
        player.leaveChorusSession();
      } else {
        player.startChorus('open');
      }
    }

    final title = (active && !isHost) ? '${c.hostName}’s Chorus' : 'Chorus';

    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: kBorder))),
      padding: const EdgeInsets.fromLTRB(14, 4, 10, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(LucideIcons.radio, size: 16, color: on ? kAccent : kMuted),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.bold))),
            Switch(value: on, onChanged: (_) => toggle()),
          ]),
          if (pending)
            Text('Waiting for ${c.hostName} to approve…',
                style: const TextStyle(fontSize: 12, color: kMuted)),
          if (c == null)
            const Text('Listen together — friends join and control the music.',
                style: TextStyle(fontSize: 12, color: kMuted)),
          if (active) ...[
            if (isHost)
              Padding(
                padding: const EdgeInsets.only(top: 2, bottom: 2),
                child: Row(children: [
                  const Expanded(
                      child: Text('Open to anyone',
                          style: TextStyle(fontSize: 13, color: kMuted))),
                  Switch(
                    value: c.mode == 'open',
                    onChanged: (v) => player.setChorusMode(v ? 'open' : 'ask'),
                  ),
                ]),
              ),
            _label('Listeners · ${c.members.length}'),
            ...c.members.map((m) => _listenerRow(context, player, c, m, isHost)),
            if (isHost && c.pending.isNotEmpty) ...[
              const SizedBox(height: 4),
              _label('Requests · ${c.pending.length}'),
              ...c.pending.map((r) => _requestRow(context, player, r)),
            ],
          ],
        ],
      ),
    );
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 2),
        child: Text(t.toUpperCase(),
            style: const TextStyle(
                fontSize: 11, color: kMuted, fontWeight: FontWeight.w600, letterSpacing: 0.5)),
      );

  Widget _avatar(String name) => CircleAvatar(
        radius: 13,
        backgroundColor: kPanel2,
        child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?',
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
      );

  Widget _listenerRow(
      BuildContext context, PlayerModel player, ChorusState c, UserRef m, bool isHost) {
    final isTheHost = m.id == c.hostId;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        _avatar(m.username),
        const SizedBox(width: 8),
        Expanded(
          child: Text(m.username,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14)),
        ),
        if (isTheHost)
          const Text('HOST',
              style: TextStyle(
                  fontSize: 10, fontWeight: FontWeight.bold, color: kAccent, letterSpacing: 0.5))
        else if (isHost)
          InkWell(
            onTap: () async {
              await context.read<Api>().removeFromChorus(m.id).catchError((_) {});
              await player.refreshChorus();
            },
            child: const Icon(LucideIcons.x, size: 16, color: kMuted),
          ),
      ]),
    );
  }

  Widget _requestRow(BuildContext context, PlayerModel player, UserRef r) {
    final api = context.read<Api>();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [
        _avatar(r.username),
        const SizedBox(width: 8),
        Expanded(
          child: Text(r.username,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14)),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'Approve',
          icon: const Icon(LucideIcons.check, size: 18, color: kAccent),
          onPressed: () async {
            await api.approveChorus(r.id).catchError((_) {});
            await player.refreshChorus();
          },
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: 'Deny',
          icon: const Icon(LucideIcons.x, size: 18, color: kMuted),
          onPressed: () async {
            await api.denyChorus(r.id).catchError((_) {});
            await player.refreshChorus();
          },
        ),
      ]),
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
