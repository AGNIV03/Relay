import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../theme.dart';
import 'liked_songs_screen.dart';
import 'playlist_detail_screen.dart';

class PlaylistsScreen extends StatefulWidget {
  const PlaylistsScreen({super.key});
  @override
  State<PlaylistsScreen> createState() => _PlaylistsScreenState();
}

class _PlaylistsScreenState extends State<PlaylistsScreen> {
  late Future<List<Playlist>> _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() => _future = context.read<Api>().playlists();

  Future<void> _create() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New playlist'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Playlist name'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (name != null && name.isNotEmpty && mounted) {
      await context.read<Api>().createPlaylist(name);
      if (mounted) setState(_load);
    }
  }

  Future<void> _delete(Playlist pl) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete "${pl.name}"?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok == true && mounted) {
      await context.read<Api>().deletePlaylist(pl.id);
      if (mounted) setState(_load);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton(
        onPressed: _create,
        child: const Icon(Icons.add),
      ),
      body: FutureBuilder<List<Playlist>>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final playlists = snap.data!;
          return GridView.builder(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 90),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 180,
              mainAxisSpacing: 16,
              crossAxisSpacing: 16,
              childAspectRatio: 0.76,
            ),
            itemCount: playlists.length + 1,
            itemBuilder: (context, idx) {
              if (idx == 0) {
                return _Tile(
                  title: 'Liked Songs',
                  subtitle: 'Your favourites',
                  cover: Container(
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(colors: [kAccent, kAccent2]),
                    ),
                    child: const Center(
                      child: Icon(LucideIcons.heart, fill: 1, size: 48, color: kAccentInk),
                    ),
                  ),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const LikedSongsScreen()),
                  ),
                );
              }
              final pl = playlists[idx - 1];
              return _Tile(
                title: pl.name,
                subtitle: '${pl.trackCount} ${pl.trackCount == 1 ? 'song' : 'songs'}',
                cover: Image.network(
                  context.read<Api>().playlistCoverUrl(pl.id),
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => Container(
                    color: kPanel2,
                    child: const Center(child: Icon(Icons.music_note, color: kMuted, size: 40)),
                  ),
                ),
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => PlaylistDetailScreen(playlistId: pl.id, name: pl.name),
                  ));
                  if (mounted) setState(_load); // refresh cover/order on return
                },
                onLongPress: () => _delete(pl),
              );
            },
          );
        },
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  final String title;
  final String subtitle;
  final Widget cover;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  const _Tile({
    required this.title,
    required this.subtitle,
    required this.cover,
    required this.onTap,
    this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      borderRadius: BorderRadius.circular(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: cover,
            ),
          ),
          const SizedBox(height: 8),
          Text(title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
          Text(subtitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: kMuted)),
        ],
      ),
    );
  }
}
