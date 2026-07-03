import 'dart:io';
import 'package:cached_network_image/cached_network_image.dart';
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
    // Decode at the display's PHYSICAL pixel size (logical size × devicePixelRatio)
    // so covers are crisp on high-DPI / scaled displays — without decoding the full
    // multi-MB source (which would be slow). A small margin keeps it sharp.
    final dpr = MediaQuery.maybeOf(context)?.devicePixelRatio ?? 2.0;
    final px = (size * dpr * 1.15).ceil();
    final localCover = trackId != null
        ? context.read<DownloadManager>().localCoverPath(trackId!)
        : null;
    Widget child;
    if (localCover != null) {
      child = Image.file(
        File(localCover),
        fit: BoxFit.cover,
        cacheWidth: px,
        errorBuilder: (context, error, stack) =>
            url != null ? _network(url!, px) : _fallback(),
      );
    } else if (url != null) {
      child = _network(url!, px);
    } else {
      child = _fallback();
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(width: size, height: size, child: child),
    );
  }

  // Disk + memory cached so scrolling lists / reopening the queue don't re-fetch
  // every cover from the network each time (they were uncached Image.network).
  // [px] = target decode width in physical pixels (see build) for crisp thumbnails.
  Widget _network(String u, int px) => CachedNetworkImage(
        imageUrl: u,
        fit: BoxFit.cover,
        memCacheWidth: px,
        memCacheHeight: px,
        filterQuality: FilterQuality.medium,
        fadeInDuration: const Duration(milliseconds: 120),
        placeholder: (context, _) => Container(color: kPanel2),
        errorWidget: (context, _, __) => _fallback(),
      );

  Widget _fallback() => Container(
        color: kPanel2,
        child: Icon(Icons.music_note, color: kMuted, size: size * 0.45),
      );
}
