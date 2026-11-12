import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../theme.dart';
import 'track_tile.dart' show promptPlaylistName;

/// One action button on a [SelectionBar].
class SelectionAction {
  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool danger;
  const SelectionAction(this.icon, this.label, this.onPressed, {this.danger = false});
}

/// "N selected" bar shown above a track list while multi-selecting (Songs,
/// playlists, Liked Songs). Actions scroll horizontally on narrow screens.
class SelectionBar extends StatelessWidget {
  final int count;
  final int total;
  final VoidCallback onClear;
  final VoidCallback onSelectAll;
  final List<SelectionAction> actions;
  const SelectionBar({
    super.key,
    required this.count,
    required this.total,
    required this.onClear,
    required this.onSelectAll,
    required this.actions,
  });

  @override
  Widget build(BuildContext context) {
    const red = Color(0xFFEF4444);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: kPanel2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: kBorder),
      ),
      child: Row(
        children: [
          IconButton(
            onPressed: onClear,
            icon: const Icon(LucideIcons.x, size: 18),
            tooltip: 'Clear selection',
          ),
          Text('$count selected', style: const TextStyle(fontWeight: FontWeight.w600)),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              reverse: true,
              child: Row(
                children: [
                  for (final a in actions)
                    TextButton.icon(
                      onPressed: a.onPressed,
                      icon: Icon(a.icon, size: 18, color: a.danger ? red : null),
                      label: Text(a.label, style: a.danger ? const TextStyle(color: red) : null),
                    ),
                  TextButton(
                    onPressed: onSelectAll,
                    child: Text(count == total ? 'Unselect all' : 'Select all'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Bottom sheet to choose a playlist (with "New playlist…" at the top).
/// [excludeId] hides the playlist the tracks come from. Returns null if dismissed.
Future<({String id, String name})?> pickPlaylist(BuildContext context,
    {required String title, String? excludeId}) async {
  final api = context.read<Api>();
  List<Playlist> all;
  try {
    all = await api.playlists();
  } catch (_) {
    all = [];
  }
  if (!context.mounted) return null;
  final playlists = all.where((p) => p.id != excludeId).toList();
  final picked = await showModalBottomSheet<Object>(
    context: context,
    backgroundColor: kPanel,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.7),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
            ),
            ListTile(
              leading: const Icon(LucideIcons.plus, size: 18, color: kAccent),
              title: const Text('New playlist…', style: TextStyle(color: kAccent)),
              onTap: () => Navigator.pop(ctx, 'new'),
            ),
            if (playlists.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('No other playlists yet', style: TextStyle(color: kMuted)),
              ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final pl in playlists)
                    ListTile(
                      leading: const Icon(LucideIcons.listMusic, size: 18),
                      title: Text(pl.name),
                      onTap: () => Navigator.pop(ctx, (id: pl.id, name: pl.name)),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
  if (picked == 'new') {
    if (!context.mounted) return null;
    final name = await promptPlaylistName(context);
    if (name == null) return null;
    try {
      return (id: await api.createPlaylist(name), name: name);
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text("Couldn't create playlist")));
      }
      return null;
    }
  }
  return picked is ({String id, String name}) ? picked : null;
}
