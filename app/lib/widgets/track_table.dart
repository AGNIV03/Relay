import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';
import 'like_button.dart';
import 'track_tile.dart' show TrackMenu;

/// Desktop/web-style columnar song list: #, Title (cover + artist), Album,
/// Uploaded by, Added, like, menu, duration. Tapping a row plays the list.
class TrackTable extends StatelessWidget {
  final List<Track> tracks;
  final VoidCallback? onChanged; // called after a destructive change (e.g. delete)
  const TrackTable({super.key, required this.tracks, this.onChanged});

  static String _fmtDuration(double seconds) {
    final s = seconds.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  static const _months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  static String _fmtAdded(String? iso) {
    if (iso == null) return '—';
    final d = DateTime.tryParse(iso)?.toLocal();
    if (d == null) return '—';
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final diff = today.difference(day).inDays;
    if (diff <= 0) return 'Today';
    if (diff == 1) return 'Yesterday';
    if (diff < 7) return '$diff days ago';
    return '${_months[d.month - 1]} ${d.day}'
        '${d.year != now.year ? ', ${d.year}' : ''}';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Header
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: Row(
            children: const [
              SizedBox(width: 32, child: Text('#', style: _hdr, textAlign: TextAlign.center)),
              SizedBox(width: 12),
              Expanded(flex: 5, child: Text('TITLE', style: _hdr)),
              Expanded(flex: 4, child: Text('ALBUM', style: _hdr)),
              SizedBox(width: 120, child: Text('UPLOADED BY', style: _hdr)),
              SizedBox(width: 96, child: Text('ADDED', style: _hdr)),
              SizedBox(width: 84), // like + menu
              SizedBox(width: 52, child: Text('TIME', style: _hdr, textAlign: TextAlign.right)),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.only(top: 4),
            itemCount: tracks.length,
            itemBuilder: (_, i) => _TrackRow(tracks: tracks, index: i, onChanged: onChanged),
          ),
        ),
      ],
    );
  }
}

const _hdr = TextStyle(
  color: kMuted,
  fontSize: 11,
  fontWeight: FontWeight.w600,
  letterSpacing: 0.6,
);

class _TrackRow extends StatefulWidget {
  final List<Track> tracks;
  final int index;
  final VoidCallback? onChanged;
  const _TrackRow({required this.tracks, required this.index, this.onChanged});
  @override
  State<_TrackRow> createState() => _TrackRowState();
}

class _TrackRowState extends State<_TrackRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final player = context.watch<PlayerModel>();
    final t = widget.tracks[widget.index];
    final isCurrent = player.current?.id == t.id;

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: () => player.playQueue(widget.tracks, start: widget.index),
        child: Container(
          color: isCurrent || _hover ? kPanel2 : Colors.transparent,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Row(
            children: [
              SizedBox(
                width: 32,
                child: Center(
                  child: isCurrent && player.playing
                      ? const Icon(LucideIcons.music2, size: 15, color: kAccent)
                      : Text('${widget.index + 1}', style: const TextStyle(color: kMuted, fontSize: 13)),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                flex: 5,
                child: Row(children: [
                  Cover(url: api.trackCoverUrl(t.id), size: 40),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(t.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontWeight: FontWeight.w500,
                                color: isCurrent ? kAccent : kText)),
                        Text(t.artistName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: kMuted, fontSize: 12)),
                      ],
                    ),
                  ),
                ]),
              ),
              Expanded(
                flex: 4,
                child: Text(t.albumTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: kMuted, fontSize: 13)),
              ),
              SizedBox(
                width: 120,
                child: Text(t.uploaderName?.isNotEmpty == true ? t.uploaderName! : '—',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: kMuted, fontSize: 13)),
              ),
              SizedBox(
                width: 96,
                child: Text(TrackTable._fmtAdded(t.createdAt),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: kMuted, fontSize: 13)),
              ),
              SizedBox(
                width: 84,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    LikeButton(trackId: t.id, size: 18),
                    TrackMenu(track: t, onChanged: widget.onChanged),
                  ],
                ),
              ),
              SizedBox(
                width: 52,
                child: Text(TrackTable._fmtDuration(t.duration),
                    textAlign: TextAlign.right,
                    style: const TextStyle(color: kMuted, fontSize: 13)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
