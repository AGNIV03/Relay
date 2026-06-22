import 'package:flutter/material.dart';
import '../app_icons.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../models.dart';
import '../theme.dart';
import 'artist_screen.dart';

class ArtistsScreen extends StatefulWidget {
  const ArtistsScreen({super.key});
  @override
  State<ArtistsScreen> createState() => _ArtistsScreenState();
}

class _ArtistsScreenState extends State<ArtistsScreen> {
  List<Artist>? _artists;
  final _controller = TextEditingController();
  String _q = '';

  @override
  void initState() {
    super.initState();
    context.read<Api>().artists().then((a) {
      if (mounted) setState(() => _artists = a);
    }).catchError((_) {
      if (mounted) setState(() => _artists = []);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final all = _artists;
    final shown = (all == null || _q.isEmpty)
        ? all
        : all.where((a) => a.name.toLowerCase().contains(_q.toLowerCase())).toList();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: TextField(
            controller: _controller,
            onChanged: (v) => setState(() => _q = v.trim()),
            decoration: InputDecoration(
              prefixIcon: const Icon(LucideIcons.search, size: 18),
              hintText: 'Search artists…',
              suffixIcon: _q.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(LucideIcons.x, size: 18),
                      onPressed: () {
                        _controller.clear();
                        setState(() => _q = '');
                      },
                    ),
            ),
          ),
        ),
        Expanded(
          child: all == null
              ? const Center(child: CircularProgressIndicator())
              : all.isEmpty
                  ? const Center(child: Text('No artists', style: TextStyle(color: kMuted)))
                  : shown!.isEmpty
                      ? const Center(
                          child: Text('No matching artists', style: TextStyle(color: kMuted)))
                      : ListView.builder(
                          itemCount: shown.length,
                          itemBuilder: (_, i) {
                            final a = shown[i];
                            return ListTile(
                              leading: const CircleAvatar(
                                  backgroundColor: kPanel2,
                                  child: Icon(LucideIcons.user, size: 18, color: kMuted)),
                              title: Text(a.name),
                              subtitle: Text('${a.albumCount} albums · ${a.trackCount} tracks'),
                              onTap: () => Navigator.of(context).push(
                                MaterialPageRoute(
                                    builder: (_) =>
                                        ArtistScreen(artistId: a.id, artistName: a.name)),
                              ),
                            );
                          },
                        ),
        ),
      ],
    );
  }
}
