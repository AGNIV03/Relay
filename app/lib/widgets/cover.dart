import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../downloads.dart';
import '../theme.dart';

/// Album/track cover with a graceful fallback when there's no art. When a
/// [trackId] is given and that track is downloaded, the locally-saved cover is
/// used (so art shows offline); otherwise it loads from [url].
class Cover extends StatelessWidget {
  final String? url;
  final String? trackId;
  final double size;
  final double radius;
  const Cover({super.key, this.url, this.trackId, this.size = 48, this.radius = 8});

  @override
  Widget build(BuildContext context) {
    final localCover = trackId != null
        ? context.read<DownloadManager>().localCoverPath(trackId!)
        : null;
    Widget child;
    if (localCover != null) {
      child = Image.file(
        File(localCover),
        fit: BoxFit.cover,
        errorBuilder: (context, error, stack) =>
            url != null ? _network(url!) : _fallback(),
      );
    } else if (url != null) {
      child = _network(url!);
    } else {
      child = _fallback();
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(width: size, height: size, child: child),
    );
  }

  Widget _network(String u) => Image.network(
        u,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stack) => _fallback(),
      );

  Widget _fallback() => Container(
        color: kPanel2,
        child: Icon(Icons.music_note, color: kMuted, size: size * 0.45),
      );
}
