import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../downloads.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import 'cover.dart';
import 'like_button.dart';
import 'track_tile.dart' show TrackMenu;

// Sort columns (0 = unsorted / original order).
const int _kTitle = 1, _kAlbum = 2, _kUploader = 3, _kAdded = 4, _kTime = 5;

/// Desktop/web-style columnar song list: #, Title (cover + artist), Album,
/// [Uploaded by], Added, like + download + menu, duration.
///
/// Clicking a column header sorts by it (toggles ascending/descending; an arrow
/// shows on the active column). Reused for both the Songs page and playlists —
/// pass [addedAtById] so the "Added" column shows when a track was added to the
/// playlist, hide [showUploadedBy], and pass [onRemove] for a remove button.
class TrackTable extends StatefulWidget {
  final List<Track> tracks;
  final VoidCallback? onChanged; // called after a destructive change (e.g. delete)
  final Map<String, String?>? addedAtById; // playlist add dates (else uses createdAt)
  final bool showUploadedBy;
  final void Function(Track)? onRemove; // playlist: remove-from-playlist button
  // Multi-select (Songs page): long-press/right-click selects; while any row is
  // selected a click toggles selection instead of starting playback.
  final Set<String> selectedIds;
  final void Function(Track)? onSelectToggle;
  // Drag-to-reorder (playlists in "Playlist order"): the # cell becomes a drag
  // handle. Called with the moved row's old index and its final index (already
  // adjusted for the removal). Only active while no column sort is applied.
  final void Function(int oldIndex, int newIndex)? onReorder;
  const TrackTable({
    super.key,
    required this.tracks,
    this.onChanged,
    this.addedAtById,
    this.showUploadedBy = true,
    this.onRemove,
    this.selectedIds = const {},
    this.onSelectToggle,
    this.onReorder,
  });

  @override
  State<TrackTable> createState() => _TrackTableState();
}

class _TrackTableState extends State<TrackTable> {
  int _sortCol = 0;
  bool _asc = true;

  static String fmtDuration(double seconds) {
    final s = seconds.round();
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  static const _months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  static String fmtAdded(String? iso) {
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
    return '${_months[d.month - 1]} ${d.day}${d.year != now.year ? ', ${d.year}' : ''}';
  }

  String? _addedIso(Track t) => widget.addedAtById?[t.id] ?? t.createdAt;

  void _sortBy(int col) => setState(() {
        if (_sortCol == col) {
          _asc = !_asc;
        } else {
          _sortCol = col;
          _asc = true;
        }
      });

  List<Track> get _sorted {
    if (_sortCol == 0) return widget.tracks;
    final list = [...widget.tracks];
    int base(Track a, Track b) {
      switch (_sortCol) {
        case _kTitle:
          return a.title.toLowerCase().compareTo(b.title.toLowerCase());
        case _kAlbum:
          return a.albumTitle.toLowerCase().compareTo(b.albumTitle.toLowerCase());
        case _kUploader:
          return (a.uploaderName ?? '').toLowerCase().compareTo((b.uploaderName ?? '').toLowerCase());
        case _kAdded:
          return (_addedIso(a) ?? '').compareTo(_addedIso(b) ?? ''); // ISO strings sort chronologically
        case _kTime:
          return a.duration.compareTo(b.duration);
        default:
          return 0;
      }
    }

    list.sort((a, b) => _asc ? base(a, b) : -base(a, b));
    return list;
  }

  /// Sortable header cell. [flex] OR [width] sizes it; an arrow shows when active.
  Widget _header(String label, int col,
      {int? flex, double? width, TextAlign align = TextAlign.left}) {
    final active = _sortCol == col;
    final row = Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment:
          align == TextAlign.right ? MainAxisAlignment.end : MainAxisAlignment.start,
      children: [
        Flexible(
          child: Text(label,
              overflow: TextOverflow.ellipsis,
              style: _hdr.copyWith(color: active ? kAccent : kMuted)),
        ),
        if (active)
          Padding(
            padding: const EdgeInsets.only(left: 3),
            child: Icon(_asc ? Icons.arrow_upward : Icons.arrow_downward, size: 12, color: kAccent),
          ),
      ],
    );
    final cell = InkWell(
      onTap: () => _sortBy(col),
      borderRadius: BorderRadius.circular(4),
      child: Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: row),
    );
    if (width != null) return SizedBox(width: width, child: cell);
    return Expanded(flex: flex!, child: cell);
  }

  @override
  Widget build(BuildContext context) {
    final sorted = _sorted;
    // Wide enough for like + download + menu (+ optional remove) at their natural
    // ~40px tap sizes; too narrow here overflows and shifts the tap targets.
    final actionsW = widget.onRemove != null ? 164.0 : 124.0;
    final reorderable = widget.onReorder != null && _sortCol == 0;
    Widget row(int i) => _TrackRow(
          tracks: sorted,
          index: i,
          onChanged: widget.onChanged,
          addedLabel: fmtAdded(_addedIso(sorted[i])),
          showUploadedBy: widget.showUploadedBy,
          actionsWidth: actionsW,
          onRemove: widget.onRemove,
          selectedIds: widget.selectedIds,
          onSelectToggle: widget.onSelectToggle,
          reorderable: reorderable,
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: Row(
            children: [
              const SizedBox(width: 32, child: Text('#', style: _hdr, textAlign: TextAlign.center)),
              const SizedBox(width: 12),
              _header('TITLE', _kTitle, flex: 5),
              _header('ALBUM', _kAlbum, flex: 4),
              if (widget.showUploadedBy) _header('UPLOADED BY', _kUploader, width: 120),
              _header('ADDED', _kAdded, width: 96),
              SizedBox(width: actionsW),
              _header('TIME', _kTime, width: 52, align: TextAlign.right),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: reorderable
              ? ReorderableListView.builder(
                  padding: const EdgeInsets.only(top: 4),
                  buildDefaultDragHandles: false,
                  itemCount: sorted.length,
                  onReorderItem: (from, to) {
                    if (to != from) widget.onReorder!(from, to);
                  },
                  itemBuilder: (_, i) => KeyedSubtree(key: ValueKey(sorted[i].id), child: row(i)),
                )
              : ListView.builder(
                  padding: const EdgeInsets.only(top: 4),
                  itemCount: sorted.length,
                  itemBuilder: (_, i) => row(i),
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
  final String addedLabel;
  final bool showUploadedBy;
  final double actionsWidth;
  final void Function(Track)? onRemove;
  final Set<String> selectedIds;
  final void Function(Track)? onSelectToggle;
  final bool reorderable; // # cell is a drag handle (inside a ReorderableListView)
  const _TrackRow({
    required this.tracks,
    required this.index,
    required this.addedLabel,
    required this.showUploadedBy,
    required this.actionsWidth,
    this.onChanged,
    this.onRemove,
    this.selectedIds = const {},
    this.onSelectToggle,
    this.reorderable = false,
  });
  @override
  State<_TrackRow> createState() => _TrackRowState();
}

class _TrackRowState extends State<_TrackRow> {
  bool _hover = false;

  Widget _downloadButton(Track t, DownloadManager downloads) {
    if (downloads.isDownloading(t.id)) {
      // Determinate ring for the active download, spinner while queued.
      final p = downloads.progressOf(t.id);
      return Tooltip(
        message: downloads.pausedForWifi
            ? 'Waiting for Wi-Fi'
            : p == null
                ? 'Queued'
                : 'Downloading ${(p * 100).round()}%',
        child: SizedBox(
          width: 36,
          height: 36,
          child: Padding(
              padding: const EdgeInsets.all(9),
              child: CircularProgressIndicator(strokeWidth: 2, value: p)),
        ),
      );
    }
    final done = downloads.isDownloaded(t.id);
    return IconButton(
      iconSize: 17,
      visualDensity: VisualDensity.compact,
      tooltip: done ? 'Remove download' : 'Download',
      icon: Icon(done ? LucideIcons.checkCircle : LucideIcons.download,
          color: done ? kAccent : kMuted),
      onPressed: () async {
        if (done) return downloads.remove(t.id);
        try {
          await downloads.download(t);
        } catch (e) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
          }
        }
      },
    );
  }

  /// The # column: selection marker, playing icon, or row number. When the
  /// table is reorderable it doubles as the drag handle (grip on hover).
  Widget _indexCell(bool selectionMode, bool isSelected, bool isPlaying) {
    final Widget content = selectionMode
        ? Icon(isSelected ? LucideIcons.checkCircle : LucideIcons.circle,
            size: 17, color: isSelected ? kAccent : kMuted)
        : widget.reorderable && _hover
            ? const Icon(Icons.drag_indicator, size: 18, color: kMuted)
            : isPlaying
                ? const Icon(LucideIcons.music2, size: 15, color: kAccent)
                : Text('${widget.index + 1}',
                    style: const TextStyle(color: kMuted, fontSize: 13));
    final cell = SizedBox(width: 32, height: 40, child: Center(child: content));
    if (!widget.reorderable || selectionMode) return cell;
    return ReorderableDragStartListener(
      index: widget.index,
      child: MouseRegion(
        cursor: SystemMouseCursors.grab,
        child: Tooltip(message: 'Drag to reorder', waitDuration: const Duration(seconds: 1), child: cell),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final t = widget.tracks[widget.index];
    // Rebuild a row only when ITS "is current / playing" state changes, not on
    // every player notification (a table can have hundreds of rows).
    final (isCurrent, isPlaying) = context.select<PlayerModel, (bool, bool)>(
        (p) => (p.current?.id == t.id, p.current?.id == t.id && p.playing));
    final player = context.read<PlayerModel>();
    final downloads = context.watch<DownloadManager>();
    final selectable = widget.onSelectToggle != null;
    final selectionMode = selectable && widget.selectedIds.isNotEmpty;
    final isSelected = widget.selectedIds.contains(t.id);

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: selectionMode
            ? () => widget.onSelectToggle!(t)
            : () => player.playQueue(widget.tracks, start: widget.index),
        onLongPress: selectable ? () => widget.onSelectToggle!(t) : null,
        onSecondaryTap: selectable ? () => widget.onSelectToggle!(t) : null,
        child: Container(
          color: isSelected
              ? kAccent.withValues(alpha: 0.18)
              : (isCurrent || _hover ? kPanel2 : Colors.transparent),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Row(
            children: [
              _indexCell(selectionMode, isSelected, isPlaying),
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
                                fontWeight: FontWeight.w500, color: isCurrent ? kAccent : kText)),
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
              if (widget.showUploadedBy)
                SizedBox(
                  width: 120,
                  child: Text(t.uploaderName?.isNotEmpty == true ? t.uploaderName! : '—',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 13)),
                ),
              SizedBox(
                width: 96,
                child: Text(widget.addedLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: kMuted, fontSize: 13)),
              ),
              SizedBox(
                width: widget.actionsWidth,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    LikeButton(trackId: t.id, size: 18),
                    if (downloads.supported) _downloadButton(t, downloads),
                    TrackMenu(track: t, onChanged: widget.onChanged),
                    if (widget.onRemove != null)
                      IconButton(
                        iconSize: 16,
                        visualDensity: VisualDensity.compact,
                        tooltip: 'Remove from playlist',
                        icon: const Icon(LucideIcons.x, color: kMuted),
                        onPressed: () => widget.onRemove!(t),
                      ),
                  ],
                ),
              ),
              SizedBox(
                width: 52,
                child: Text(_TrackTableState.fmtDuration(t.duration),
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
