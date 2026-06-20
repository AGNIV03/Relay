import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/album_grid.dart';
import 'artist_screen.dart';
import 'playlists_screen.dart';

class LibraryScreen extends StatelessWidget {
  const LibraryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Column(
        children: const [
          TabBar(
            indicatorColor: kAccent2,
            labelColor: kAccent2,
            unselectedLabelColor: kMuted,
            tabs: [Tab(text: 'Albums'), Tab(text: 'Artists'), Tab(text: 'Playlists')],
          ),
          Expanded(
            child: TabBarView(
              children: [_AlbumsTab(), _ArtistsTab(), PlaylistsScreen()],
            ),
          ),
        ],
      ),
    );
  }
}

class _AlbumsTab extends StatefulWidget {
  const _AlbumsTab();
  @override
  State<_AlbumsTab> createState() => _AlbumsTabState();
}

class _AlbumsTabState extends State<_AlbumsTab> with AutomaticKeepAliveClientMixin {
  late Future<List<Album>> _future;
  @override
  bool get wantKeepAlive => true;
  @override
  void initState() {
    super.initState();
    _future = context.read<Api>().albums();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return FutureBuilder<List<Album>>(
      future: _future,
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        if (snap.data!.isEmpty) {
          return const Center(child: Text('No albums', style: TextStyle(color: kMuted)));
        }
        return AlbumGrid(albums: snap.data!);
      },
    );
  }
}

class _ArtistsTab extends StatefulWidget {
  const _ArtistsTab();
  @override
  State<_ArtistsTab> createState() => _ArtistsTabState();
}

class _ArtistsTabState extends State<_ArtistsTab> with AutomaticKeepAliveClientMixin {
  late Future<List<Artist>> _future;
  @override
  bool get wantKeepAlive => true;
  @override
  void initState() {
    super.initState();
    _future = context.read<Api>().artists();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return FutureBuilder<List<Artist>>(
      future: _future,
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final artists = snap.data!;
        if (artists.isEmpty) {
          return const Center(child: Text('No artists', style: TextStyle(color: kMuted)));
        }
        return ListView.builder(
          itemCount: artists.length,
          itemBuilder: (context, i) {
            final a = artists[i];
            return ListTile(
              leading: const CircleAvatar(backgroundColor: kPanel2, child: Icon(Icons.person)),
              title: Text(a.name),
              subtitle: Text('${a.albumCount} albums · ${a.trackCount} tracks'),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => ArtistScreen(artistId: a.id, artistName: a.name),
              )),
            );
          },
        );
      },
    );
  }
}
