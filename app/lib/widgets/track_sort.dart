import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../app_icons.dart';
import '../models.dart';
import '../theme.dart';

/// Ordering for a playlist's tracks. [custom] is the playlist's own order.
enum TrackOrder { custom, title, artist, album, added, duration }

const _labels = {
  TrackOrder.custom: 'Playlist order',
  TrackOrder.title: 'Title',
  TrackOrder.artist: 'Artist',
  TrackOrder.album: 'Album',
  TrackOrder.added: 'Date added',
  TrackOrder.duration: 'Length',
};

/// Sort [tracks] by [order] (stable copy). [addedAt] maps trackId to when it was
/// added to this list (used by [TrackOrder.added]; tracks without one sort last).
List<Track> sortTracks(List<Track> tracks, TrackOrder order, bool asc,
    {Map<String, String?>? addedAt}) {
  if (order == TrackOrder.custom) return asc ? List.of(tracks) : tracks.reversed.toList();
  int cmp(Track a, Track b) {
    switch (order) {
      case TrackOrder.custom:
        return 0;
      case TrackOrder.title:
        return a.title.toLowerCase().compareTo(b.title.toLowerCase());
      case TrackOrder.artist:
        return a.artistName.toLowerCase().compareTo(b.artistName.toLowerCase());
      case TrackOrder.album:
        return a.albumTitle.toLowerCase().compareTo(b.albumTitle.toLowerCase());
      case TrackOrder.added:
        final x = addedAt?[a.id] ?? a.createdAt ?? '';
        final y = addedAt?[b.id] ?? b.createdAt ?? '';
        return x.compareTo(y);
      case TrackOrder.duration:
        return a.duration.compareTo(b.duration);
    }
  }

  final indexed = [for (var i = 0; i < tracks.length; i++) (i, tracks[i])];
  indexed.sort((p, q) {
    final c = cmp(p.$2, q.$2);
    return c != 0 ? (asc ? c : -c) : p.$1.compareTo(q.$1); // stable
  });
  return [for (final e in indexed) e.$2];
}

/// Remembered per-list sort choice, persisted under `sort_<key>`.
class TrackSortState {
  TrackOrder order = TrackOrder.custom;
  bool asc = true;

  Future<void> load(String key) async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString('sort_$key');
    if (raw == null) return;
    final parts = raw.split(':');
    order = TrackOrder.values.firstWhere((o) => o.name == parts.first,
        orElse: () => TrackOrder.custom);
    asc = parts.length < 2 || parts[1] != 'desc';
  }

  Future<void> save(String key) async {
    final p = await SharedPreferences.getInstance();
    await p.setString('sort_$key', '${order.name}:${asc ? 'asc' : 'desc'}');
  }

  /// Picking the active order again flips its direction.
  void pick(TrackOrder o) {
    if (o == order) {
      asc = !asc;
    } else {
      order = o;
      asc = true;
    }
  }
}

/// App-bar sort menu for a track list (same look as the Songs page).
class TrackSortButton extends StatelessWidget {
  final TrackSortState state;
  final ValueChanged<TrackOrder> onSelected;
  final bool showAdded;
  const TrackSortButton(
      {super.key, required this.state, required this.onSelected, this.showAdded = true});

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<TrackOrder>(
      icon: const Icon(LucideIcons.arrowDownUp, size: 20),
      tooltip: 'Sort',
      color: kPanel2,
      onSelected: onSelected,
      itemBuilder: (_) => [
        for (final e in _labels.entries)
          if (showAdded || e.key != TrackOrder.added)
            PopupMenuItem(
              value: e.key,
              child: Row(children: [
                Expanded(
                  child: Text(e.value,
                      style: TextStyle(color: state.order == e.key ? kAccent : null)),
                ),
                if (state.order == e.key)
                  Icon(state.asc ? LucideIcons.arrowUp : LucideIcons.arrowDown,
                      size: 15, color: kAccent),
              ]),
            ),
      ],
    );
  }
}
