import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../player.dart';
import '../theme.dart';
import '../screens/playlist_detail_screen.dart';
import 'cover.dart';

/// Show a popup with a user's details, favorite songs, and playlists.
Future<void> showUserProfileDialog(BuildContext context, String userId) {
  return showDialog(
    context: context,
    builder: (_) => _UserProfileDialog(userId: userId),
  );
}

class _UserProfileDialog extends StatefulWidget {
  final String userId;
  const _UserProfileDialog({required this.userId});
  @override
  State<_UserProfileDialog> createState() => _UserProfileDialogState();
}

class _UserProfileDialogState extends State<_UserProfileDialog> {
  UserProfile? _p;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    context.read<Api>().userProfile(widget.userId).then((p) {
      if (mounted) setState(() => _p = p);
    }).catchError((_) {
      if (mounted) setState(() => _error = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    return Dialog(
      backgroundColor: kPanel,
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460, maxHeight: 600),
        child: p == null
            ? SizedBox(
                height: 160,
                child: Center(
                  child: _error
                      ? const Text("Couldn't load profile", style: TextStyle(color: kMuted))
                      : const CircularProgressIndicator(),
                ),
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _header(p),
                  const Divider(height: 1),
                  Flexible(
                    child: ListView(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      children: [
                        if (p.favorites.isNotEmpty) ...[
                          _sectionTitle('Favorite songs'),
                          ...p.favorites.take(30).toList().asMap().entries.map(
                                (e) => _trackRow(p.favorites, e.key),
                              ),
                        ],
                        if (p.playlists.isNotEmpty) ...[
                          _sectionTitle('Playlists'),
                          ...p.playlists.map(_playlistRow),
                        ],
                        if (p.favorites.isEmpty && p.playlists.isEmpty)
                          Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                                p.isPrivate
                                    ? 'This user keeps their likes private'
                                    : 'No favorites or playlists yet',
                                textAlign: TextAlign.center,
                                style: const TextStyle(color: kMuted)),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Widget _header(UserProfile p) {
    final joined = p.createdAt != null ? DateTime.tryParse(p.createdAt!)?.toLocal() : null;
    final joinedStr = joined != null ? ' · joined ${joined.year}' : '';
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(children: [
        Container(
          width: 56,
          height: 56,
          decoration: const BoxDecoration(
            gradient: LinearGradient(colors: [kAccent, kAccent2]),
            shape: BoxShape.circle,
          ),
          child: Center(
            child: Text(p.username.isNotEmpty ? p.username[0].toUpperCase() : '?',
                style: const TextStyle(
                    fontSize: 24, fontWeight: FontWeight.bold, color: kAccentInk)),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(p.username,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold)),
            Text('${p.role}$joinedStr', style: const TextStyle(color: kMuted, fontSize: 12)),
            const SizedBox(height: 4),
            Text(
                p.isPrivate
                    ? 'Likes and activity are private · ${p.playlists.length} public playlists'
                    : '${p.likeCount} liked · ${p.playlists.length} playlists',
                style: const TextStyle(color: kMuted, fontSize: 12)),
          ]),
        ),
        IconButton(
          icon: const Icon(LucideIcons.x, size: 18),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ]),
    );
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        child: Text(t.toUpperCase(),
            style: const TextStyle(
                color: kMuted, fontSize: 11, fontWeight: FontWeight.w600, letterSpacing: 0.6)),
      );

  Widget _trackRow(List<Track> favorites, int i) {
    final t = favorites[i];
    final api = context.read<Api>();
    return ListTile(
      dense: true,
      leading: Cover(url: api.trackCoverUrl(t.id), size: 38),
      title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(t.artistName,
          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
      onTap: () {
        context.read<PlayerModel>().playQueue(favorites, start: i);
        Navigator.of(context).pop();
      },
    );
  }

  Widget _playlistRow(Playlist pl) {
    return ListTile(
      dense: true,
      leading: const SizedBox(
        width: 38,
        height: 38,
        child: Icon(LucideIcons.listMusic, color: kMuted),
      ),
      title: Text(pl.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text('${pl.trackCount} songs', style: const TextStyle(fontSize: 12)),
      onTap: () {
        Navigator.of(context).pop();
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => PlaylistDetailScreen(playlistId: pl.id, name: pl.name),
        ));
      },
    );
  }
}
