import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../widgets/album_grid.dart';

class ArtistScreen extends StatefulWidget {
  final String artistId;
  final String artistName;
  const ArtistScreen({super.key, required this.artistId, required this.artistName});
  @override
  State<ArtistScreen> createState() => _ArtistScreenState();
}

class _ArtistScreenState extends State<ArtistScreen> {
  late Future<List<Album>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<Api>().artistAlbums(widget.artistId);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.artistName)),
      body: FutureBuilder<List<Album>>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          return AlbumGrid(albums: snap.data!);
        },
      ),
    );
  }
}
