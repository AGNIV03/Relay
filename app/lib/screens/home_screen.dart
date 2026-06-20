import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/album_grid.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<List<Album>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<Api>().recentAlbums();
  }

  Future<void> _refresh() async {
    setState(() => _future = context.read<Api>().recentAlbums());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: FutureBuilder<List<Album>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return _Message('Could not load library.\n${snap.error}');
          }
          final albums = snap.data ?? [];
          if (albums.isEmpty) {
            return _Message('Your library is empty. Add music on the server and run a scan.');
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
                child: Text('Recently added',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              ),
              Expanded(child: AlbumGrid(albums: albums)),
            ],
          );
        },
      ),
    );
  }
}

class _Message extends StatelessWidget {
  final String text;
  const _Message(this.text);
  @override
  Widget build(BuildContext context) => ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(32),
            child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: kMuted)),
          ),
        ],
      );
}
