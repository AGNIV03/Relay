import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/cover.dart';
import '../widgets/track_tile.dart';
import 'album_detail_screen.dart';
import 'artist_screen.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _controller = TextEditingController();
  Timer? _debounce;
  List<Track> _tracks = [];
  List<Album> _albums = [];
  List<Artist> _artists = [];
  bool _searched = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => _run(q));
  }

  Future<void> _run(String q) async {
    if (q.trim().isEmpty) {
      setState(() {
        _tracks = [];
        _albums = [];
        _artists = [];
        _searched = false;
      });
      return;
    }
    try {
      final r = await context.read<Api>().search(q);
      if (!mounted) return;
      setState(() {
        _tracks = r['tracks'] as List<Track>;
        _albums = r['albums'] as List<Album>;
        _artists = r['artists'] as List<Artist>;
        _searched = true;
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: _controller,
            autofocus: true,
            onChanged: _onChanged,
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Songs, albums, artists…',
            ),
          ),
        ),
        Expanded(
          child: ListView(
            children: [
              if (_searched && _tracks.isEmpty && _albums.isEmpty && _artists.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(32),
                  child: Text('No results', textAlign: TextAlign.center,
                      style: TextStyle(color: kMuted)),
                ),
              if (_artists.isNotEmpty) const _Header('Artists'),
              ..._artists.map((a) => ListTile(
                    leading: const CircleAvatar(
                        backgroundColor: kPanel2, child: Icon(Icons.person)),
                    title: Text(a.name),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => ArtistScreen(artistId: a.id, artistName: a.name),
                    )),
                  )),
              if (_albums.isNotEmpty) const _Header('Albums'),
              ..._albums.map((al) => ListTile(
                    leading: Cover(url: api.albumCoverUrl(al.id), size: 44),
                    title: Text(al.title),
                    subtitle: Text(al.artist?.name ?? ''),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => AlbumDetailScreen(albumId: al.id),
                    )),
                  )),
              if (_tracks.isNotEmpty) const _Header('Songs'),
              for (int i = 0; i < _tracks.length; i++) TrackTile(tracks: _tracks, index: i),
            ],
          ),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  final String text;
  const _Header(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(text, style: const TextStyle(fontWeight: FontWeight.bold, color: kMuted)),
      );
}
