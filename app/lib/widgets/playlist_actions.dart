import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app_icons.dart';
import '../downloads.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';

/// Icon-only playlist controls (Play / Shuffle / Add to queue / Download), all
/// the same round size. Toggles use fully inverted colours so their state is
/// obvious at a glance: ON = solid cyan with a dark icon, OFF = dark with a cyan
/// outline and a cyan icon.
const double _kSize = 48;

Widget _roundButton({
  required String tooltip,
  required Widget icon,
  required VoidCallback? onPressed,
  bool filled = false,
  Color? outline,
}) {
  return Tooltip(
    message: tooltip,
    child: SizedBox(
      width: _kSize,
      height: _kSize,
      child: Material(
        color: filled ? kAccent : Colors.transparent,
        shape: CircleBorder(
          side: filled ? BorderSide.none : BorderSide(color: outline ?? kAccent, width: 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(onTap: onPressed, child: Center(child: icon)),
      ),
    ),
  );
}

/// Primary Play button: a solid cyan circle.
class PlayRoundButton extends StatelessWidget {
  final VoidCallback? onPressed;
  const PlayRoundButton({super.key, required this.onPressed});
  @override
  Widget build(BuildContext context) => _roundButton(
        tooltip: 'Play',
        filled: true,
        icon: const Icon(LucideIcons.play, color: kAccentInk, size: 28),
        onPressed: onPressed,
      );
}

/// A playlist's remembered Shuffle toggle.
class ShuffleToggleButton extends StatelessWidget {
  final bool on;
  final VoidCallback onPressed;
  const ShuffleToggleButton({super.key, required this.on, required this.onPressed});

  @override
  Widget build(BuildContext context) => _roundButton(
        tooltip: on ? 'Shuffle on' : 'Shuffle off',
        filled: on,
        icon: Icon(LucideIcons.shuffle, color: on ? kAccentInk : kAccent, size: 22),
        onPressed: onPressed,
      );
}

/// Appends a whole playlist to the play queue (after anything already queued).
/// Follows the playlist's Shuffle toggle: when [shuffle] is on the songs are
/// queued in a random order.
class AddToQueueButton extends StatelessWidget {
  final List<Track> tracks;
  final bool shuffle;
  const AddToQueueButton({super.key, required this.tracks, this.shuffle = false});

  @override
  Widget build(BuildContext context) => _roundButton(
        tooltip: 'Add to queue',
        outline: kBorder,
        icon: const Icon(LucideIcons.addToQueue, size: 22),
        onPressed: tracks.isEmpty
            ? null
            : () async {
                final messenger = ScaffoldMessenger.of(context);
                await context
                    .read<PlayerModel>()
                    .addAllToQueue(shuffle ? (List.of(tracks)..shuffle()) : tracks);
                messenger.showSnackBar(SnackBar(
                  content: Text('Added ${tracks.length} ${tracks.length == 1 ? 'song' : 'songs'} '
                      'to the queue${shuffle && tracks.length > 1 ? ', shuffled' : ''}'),
                  duration: const Duration(seconds: 2),
                ));
              },
      );
}

/// Download / remove the whole list. Inverted (solid cyan) once everything is
/// downloaded; a progress ring while the queue is working.
class DownloadToggleButton extends StatelessWidget {
  final List<Track> tracks;
  final String source; // playlist id, or 'liked'
  final String name;
  const DownloadToggleButton(
      {super.key, required this.tracks, required this.source, required this.name});

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadManager>();
    if (!downloads.supported) return const SizedBox.shrink();
    final allDown = downloads.allDownloaded(tracks);
    final done = downloads.downloadedCount(tracks);
    final pending = downloads.anyPending(tracks);
    final Widget icon;
    if (pending) {
      icon = SizedBox(
        width: 26,
        height: 26,
        child: CircularProgressIndicator(
          strokeWidth: 2.5,
          value: tracks.isEmpty ? null : done / tracks.length,
          backgroundColor: kBorder,
        ),
      );
    } else {
      icon = Icon(allDown ? LucideIcons.checkCircle : LucideIcons.download,
          color: allDown ? kAccentInk : kAccent, size: 22);
    }
    // Wi-Fi only and on mobile data: the queue is held, so say so on the button.
    final waitingWifi = !allDown && downloads.wifiBlocked;
    final button = _roundButton(
      tooltip: allDown
          ? 'Downloaded (tap to remove)'
          : waitingWifi
              ? 'Waiting for Wi-Fi ($done of ${tracks.length} saved)'
              : pending
                  ? 'Downloading $done of ${tracks.length}'
                  : done > 0
                      ? 'Download ($done of ${tracks.length} saved)'
                      : 'Download',
      filled: allDown,
      icon: icon,
      onPressed: tracks.isEmpty
          ? null
          : () async {
              if (allDown) {
                await downloads.removeAll(tracks, source);
              } else {
                await downloads.downloadAll(tracks, source, name: name);
                if (downloads.wifiBlocked && context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text('Queued. Downloads start when you are on Wi-Fi '
                        '(change this in Settings).'),
                  ));
                }
              }
            },
    );
    if (!waitingWifi) return button;
    return Stack(clipBehavior: Clip.none, children: [
      button,
      Positioned(
        right: -2,
        bottom: -2,
        child: IgnorePointer(
          child: Container(
            padding: const EdgeInsets.all(3),
            decoration: BoxDecoration(
              color: kPanel2,
              shape: BoxShape.circle,
              border: Border.all(color: kBorder),
            ),
            child: const Icon(Icons.wifi_off, size: 12, color: kMuted),
          ),
        ),
      ),
    ]);
  }
}
