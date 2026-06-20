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
  Widget build(BuildContext context) {
    if (_artists == null) return const Center(child: CircularProgressIndicator());
    if (_artists!.isEmpty) return const Center(child: Text("No artists", style: TextStyle(color: kMuted)));
    return ListView.builder(
      itemCount: _artists!.length,
      itemBuilder: (_, i) {
        final a = _artists![i];
        return ListTile(
          leading: const CircleAvatar(backgroundColor: kPanel2, child: Icon(LucideIcons.user, size: 18, color: kMuted)),
          title: Text(a.name),
          subtitle: Text("${a.albumCount} albums · ${a.trackCount} tracks"),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => ArtistScreen(artistId: a.id, artistName: a.name)),
          ),
        );
      },
    );
  }
}
