import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';

/// The play queue contents (current track + what's coming up). Tap to jump, ✕ to
/// remove. Used both full-screen (mobile) and in the desktop right-side panel.
class QueuePanel extends StatelessWidget {
  const QueuePanel({super.key});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final q = player.queue;
    final idx = player.index;

    Widget tile(Track t, {bool current = false, int? removeAt}) => ListTile(
          leading: Cover(url: api.trackCoverUrl(t.id), size: 44),
          title: Text(t.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontWeight: FontWeight.w600, color: current ? kAccent : null)),
          subtitle: Text(t.artistName, maxLines: 1, overflow: TextOverflow.ellipsis),
          trailing: removeAt == null
              ? null
              : IconButton(
                  icon: const Icon(LucideIcons.x, size: 18),
                  onPressed: () => player.removeFromQueue(removeAt),
                ),
          onTap: removeAt == null ? null : () => player.playAt(removeAt),
        );

    if (q.isEmpty || idx < 0 || idx >= q.length) {
      return const Center(child: Text('Nothing in the queue', style: TextStyle(color: kMuted)));
    }

    // Two layers: manually-queued songs ("Next in queue") play before the rest of
    // the context ("Next up") resumes.
    final inQueue = <int>[];
    final fromContext = <int>[];
    for (var i = idx + 1; i < q.length; i++) {
      (player.isUserQueuedAt(i) ? inQueue : fromContext).add(i);
    }

    Widget header(String label) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 2),
          child: Text(label, style: const TextStyle(color: kMuted, fontSize: 11, letterSpacing: 1)),
        );

    return ListView(
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 12, 16, 2),
          child: Text('NOW PLAYING',
              style: TextStyle(color: kMuted, fontSize: 11, letterSpacing: 1)),
        ),
        tile(q[idx], current: true),
        if (inQueue.isNotEmpty) ...[
          header('NEXT IN QUEUE'),
          for (final i in inQueue) tile(q[i], removeAt: i),
        ],
        if (fromContext.isNotEmpty) ...[
          header('NEXT UP'),
          for (final i in fromContext) tile(q[i], removeAt: i),
        ],
      ],
    );
  }
}

/// Full-screen queue (mobile: pushed from the now-playing screen).
class QueueScreen extends StatelessWidget {
  const QueueScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Queue')),
      body: const QueuePanel(),
    );
  }
}
