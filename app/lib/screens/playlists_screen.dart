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
          return ListView.builder(
            itemCount: playlists.length + 1,
            itemBuilder: (context, idx) {
              if (idx == 0) {
                // Permanent, undeletable Liked Songs playlist.
                return Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      colors: [Color(0x3322D3EE), Colors.transparent],
                      begin: Alignment.centerLeft,
                      end: Alignment.centerRight,
                    ),
                  ),
                  child: ListTile(
                    leading: Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        gradient: const LinearGradient(colors: [kAccent, kAccent2]),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: const Icon(LucideIcons.heart, fill: 1, color: kAccentInk),
                    ),
                    title: const Text('Liked Songs',
                        style: TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: const Text('Your favourites'),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const LikedSongsScreen()),
                    ),
                  ),
                );
              }
              final pl = playlists[idx - 1];
              return ListTile(
                leading: const Icon(Icons.queue_music),
                title: Text(pl.name),
                subtitle: Text('${pl.trackCount} tracks'),
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline),
                  onPressed: () async {
                    await context.read<Api>().deletePlaylist(pl.id);
                    setState(_load);
                  },
                ),
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => PlaylistDetailScreen(playlistId: pl.id, name: pl.name),
                  ));
                  setState(_load);
                },
              );
            },
          );
        },
      ),
    );
  }
}
