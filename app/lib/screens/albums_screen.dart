import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/album_grid.dart';

enum _AlbumOrder { recent, title, artist, year }

/// Every album in the library (opened from Home's "Recently added" header).
/// Newest first by default, with search and a sort menu like the Songs page.
class AlbumsScreen extends StatefulWidget {
  const AlbumsScreen({super.key});
  @override
  State<AlbumsScreen> createState() => _AlbumsScreenState();
}

class _AlbumsScreenState extends State<AlbumsScreen> {
  late final Future<List<Album>> _future = context.read<Api>().albums();
  final _search = TextEditingController();
  String _q = '';
  _AlbumOrder _order = _AlbumOrder.recent;
  bool _asc = true;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<Album> _ordered(List<Album> all) {
    final q = _q.toLowerCase();
    final l = all
        .where((a) =>
            q.isEmpty ||
            a.title.toLowerCase().contains(q) ||
            (a.artist?.name.toLowerCase().contains(q) ?? false))
        .toList();
    int cmp(Album a, Album b) {
      switch (_order) {
        case _AlbumOrder.recent:
          return (b.createdAt ?? '').compareTo(a.createdAt ?? ''); // newest first
        case _AlbumOrder.title:
          return a.title.toLowerCase().compareTo(b.title.toLowerCase());
        case _AlbumOrder.artist:
          return (a.artist?.name ?? '').toLowerCase().compareTo((b.artist?.name ?? '').toLowerCase());
        case _AlbumOrder.year:
          return (b.year ?? 0).compareTo(a.year ?? 0); // newest year first
      }
    }

    l.sort(cmp);
    return _asc ? l : l.reversed.toList();
  }

  Widget _sortButton() {
    const labels = {
      _AlbumOrder.recent: 'Recently added',
      _AlbumOrder.title: 'Title',
      _AlbumOrder.artist: 'Artist',
      _AlbumOrder.year: 'Year',
    };
    return PopupMenuButton<_AlbumOrder>(
      icon: const Icon(LucideIcons.arrowDownUp, size: 20),
      tooltip: 'Sort',
      color: kPanel2,
      onSelected: (o) => setState(() {
        if (o == _order) {
          _asc = !_asc;
        } else {
          _order = o;
          _asc = true;
        }
      }),
      itemBuilder: (_) => [
        for (final e in labels.entries)
          PopupMenuItem(
            value: e.key,
            child: Row(children: [
              Expanded(
                child: Text(e.value, style: TextStyle(color: _order == e.key ? kAccent : null)),
              ),
              if (_order == e.key)
                Icon(_asc ? LucideIcons.arrowUp : LucideIcons.arrowDown, size: 15, color: kAccent),
            ]),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Albums'), actions: [_sortButton(), const SizedBox(width: 4)]),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: TextField(
              controller: _search,
              onChanged: (v) => setState(() => _q = v.trim()),
              onTapOutside: (_) => FocusManager.instance.primaryFocus?.unfocus(),
              decoration: InputDecoration(
                prefixIcon: const Icon(LucideIcons.search, size: 18),
                hintText: 'Search albums or artists…',
                suffixIcon: _q.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(LucideIcons.x, size: 18),
                        onPressed: () {
                          _search.clear();
                          setState(() => _q = '');
                        },
                      ),
              ),
            ),
          ),
          Expanded(
            child: FutureBuilder<List<Album>>(
              future: _future,
              builder: (context, snap) {
                if (snap.hasError) {
                  return const Center(
                      child: Text("Couldn't load albums", style: TextStyle(color: kMuted)));
                }
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final albums = _ordered(snap.data!);
                if (albums.isEmpty) {
                  return const Center(child: Text('No albums', style: TextStyle(color: kMuted)));
                }
                return AlbumGrid(albums: albums);
              },
            ),
          ),
        ],
      ),
    );
  }
}
