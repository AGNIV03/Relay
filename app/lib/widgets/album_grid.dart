import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../theme.dart';
import 'cover.dart';
import '../screens/album_detail_screen.dart';

class AlbumGrid extends StatelessWidget {
  final List<Album> albums;
  const AlbumGrid({super.key, required this.albums});

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 180,
        childAspectRatio: 0.78,
        crossAxisSpacing: 12,
        mainAxisSpacing: 12,
      ),
      itemCount: albums.length,
      itemBuilder: (context, i) {
        final a = albums[i];
        return InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => AlbumDetailScreen(albumId: a.id)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AspectRatio(
                aspectRatio: 1,
                child: Cover(url: api.albumCoverUrl(a.id), size: 180, radius: 10),
              ),
              const SizedBox(height: 6),
              Text(a.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w500)),
              Text(a.artist?.name ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: kMuted, fontSize: 12)),
            ],
          ),
        );
      },
    );
  }
}
