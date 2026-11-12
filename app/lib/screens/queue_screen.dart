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

    Widget tile(Track t, {bool current = false, int? removeAt, Key? key}) => ListTile(
          key: key,
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
    // A third, trailing section holds the tracks autoplay appended when the
    // queue ran out (similar songs from the radio endpoint).
    final inQueue = <int>[];
    final fromContext = <int>[];
    final fromAutoplay = <int>[];
    for (var i = idx + 1; i < q.length; i++) {
      if (player.isUserQueuedAt(i)) {
        inQueue.add(i);
      } else if (player.isAutoplayAt(i)) {
        fromAutoplay.add(i);
      } else {
        fromContext.add(i);
      }
    }

    Widget header(String label, {VoidCallback? onClear, Widget? trailing}) => Padding(
          padding: EdgeInsets.fromLTRB(16, onClear == null && trailing == null ? 18 : 8, 4, 2),
          child: Row(children: [
            Expanded(
              child: Text(label,
                  style: const TextStyle(color: kMuted, fontSize: 11, letterSpacing: 1)),
            ),
            if (onClear != null)
              TextButton(
                onPressed: onClear,
                style: TextButton.styleFrom(foregroundColor: kAccent, visualDensity: VisualDensity.compact),
                child: const Text('Clear'),
              ),
            ?trailing,
          ]),
        );

    // A drag-to-reorder list for one queue section (indices are contiguous global
    // positions). Drag the handle to change play order.
    Widget reorderSection(List<int> section) => ReorderableListView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: section.length,
          itemBuilder: (context, li) {
            final gi = section[li];
            return tile(q[gi], removeAt: gi, key: ValueKey('q_${q[gi].id}_$gi'));
          },
          onReorder: (oldIndex, newIndex) {
            if (newIndex > oldIndex) newIndex -= 1;
            player.moveInQueue(section[oldIndex], section[newIndex]);
          },
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
          // Clear only the songs added by hand; the playlist/album carries on.
          header('NEXT IN QUEUE', onClear: () => player.clearQueue(userQueueOnly: true)),
          reorderSection(inQueue),
        ],
        if (fromContext.isNotEmpty) ...[
          header('NEXT UP'),
          reorderSection(fromContext),
        ],
        // Autoplay: similar songs keep playing after the queue ends. The switch
        // turns it off (and drops the upcoming autoplay tracks) or back on.
        if (!player.isChorusMember && !player.listeningAlong) ...[
          header('AUTOPLAY',
              trailing: Transform.scale(
                scale: 0.8,
                child: Switch(
                  value: player.autoplayEnabled,
                  onChanged: player.setAutoplay,
                ),
              )),
          if (fromAutoplay.isNotEmpty)
            reorderSection(fromAutoplay)
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Text(
                player.autoplayEnabled
                    ? 'Similar songs will play when your queue ends.'
                    : 'Turn on to keep playing similar songs when your queue ends.',
                style: const TextStyle(color: kMuted, fontSize: 12),
              ),
            ),
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
    final player = context.watch<PlayerModel>();
    final hasUpcoming = player.index >= 0 && player.index < player.queue.length - 1;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Queue'),
        actions: [
          ClearQueueButton(enabled: hasUpcoming),
          const SizedBox(width: 4),
        ],
      ),
      body: const QueuePanel(),
    );
  }
}

/// Clears everything after the current song (which keeps playing).
class ClearQueueButton extends StatelessWidget {
  final bool enabled;
  const ClearQueueButton({super.key, required this.enabled});
  @override
  Widget build(BuildContext context) => TextButton.icon(
        onPressed: !enabled
            ? null
            : () async {
                final messenger = ScaffoldMessenger.of(context);
                await context.read<PlayerModel>().clearQueue();
                messenger.showSnackBar(const SnackBar(
                  content: Text('Queue cleared'),
                  duration: Duration(seconds: 2),
                ));
              },
        icon: const Icon(LucideIcons.trash2, size: 18),
        label: const Text('Clear queue'),
      );
}
