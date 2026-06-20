import 'package:flutter/material.dart';
import '../theme.dart';

/// Album/track cover with a graceful fallback when there's no art.
class Cover extends StatelessWidget {
  final String? url;
  final double size;
  final double radius;
  const Cover({super.key, this.url, this.size = 48, this.radius = 8});

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        width: size,
        height: size,
        child: url == null
            ? _fallback()
            : Image.network(
                url!,
                fit: BoxFit.cover,
                errorBuilder: (context, error, stack) => _fallback(),
              ),
      ),
    );
  }

  Widget _fallback() => Container(
        color: kPanel2,
        child: Icon(Icons.music_note, color: kMuted, size: size * 0.45),
      );
}
