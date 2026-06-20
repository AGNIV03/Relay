import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/lyrics_pane.dart';

/// Lyrics shown in the content area (pushed onto a tab navigator) so the sidebar
/// + player bar stay visible. Tracks the current song.
class LyricsScreen extends StatelessWidget {
  const LyricsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final track = player.current;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          track == null ? "Lyrics" : "${track.title} — Lyrics",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: track == null
          ? const Center(child: Text("Nothing playing", style: TextStyle(color: kMuted)))
          : LyricsPane(player: player),
    );
  }
}
