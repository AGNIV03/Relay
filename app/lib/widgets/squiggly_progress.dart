import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../theme.dart';

/// Pixel-style "squiggly" seek bar: the played portion is an animated sine wave
/// that ripples while playing; the rest is a flat line, with a thumb at the head.
/// Tap or drag to seek.
class SquigglyProgress extends StatefulWidget {
  final Duration position;
  final Duration duration;
  final bool playing;
  final ValueChanged<Duration> onSeek;
  final double height;

  const SquigglyProgress({
    super.key,
    required this.position,
    required this.duration,
    required this.playing,
    required this.onSeek,
    this.height = 28,
  });

  @override
  State<SquigglyProgress> createState() => _SquigglyProgressState();
}

class _SquigglyProgressState extends State<SquigglyProgress>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();
  double _phase = 0;
  double? _dragFrac;

  @override
  void initState() {
    super.initState();
    _ctrl.addListener(() {
      if (widget.playing && _dragFrac == null) {
        setState(() => _phase += 0.13); // ripple advance per frame
      }
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _seekTo(double localX, double width) {
    final frac = (localX / width).clamp(0.0, 1.0);
    setState(() => _dragFrac = frac);
    widget.onSeek(Duration(milliseconds: (frac * widget.duration.inMilliseconds).round()));
  }

  @override
  Widget build(BuildContext context) {
    final durMs = widget.duration.inMilliseconds;
    final liveFrac = durMs > 0 ? widget.position.inMilliseconds / durMs : 0.0;
    final frac = (_dragFrac ?? liveFrac).clamp(0.0, 1.0);
    return LayoutBuilder(
      builder: (context, c) {
        final w = c.maxWidth;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => _seekTo(d.localPosition.dx, w),
          onHorizontalDragUpdate: (d) => _seekTo(d.localPosition.dx, w),
          onHorizontalDragEnd: (_) => setState(() => _dragFrac = null),
          child: SizedBox(
            width: double.infinity,
            height: widget.height,
            child: CustomPaint(
              painter: _SquigglyPainter(
                frac: frac,
                phase: _phase,
                animate: widget.playing,
              ),
            ),
          ),
        );
      },
    );
  }
}

class _SquigglyPainter extends CustomPainter {
  final double frac;
  final double phase;
  final bool animate;
  _SquigglyPainter({required this.frac, required this.phase, required this.animate});

  @override
  void paint(Canvas canvas, Size size) {
    final mid = size.height / 2;
    final headX = (frac * size.width).clamp(0.0, size.width);
    const amp = 4.5;
    const wavelength = 22.0;

    final remaining = Paint()
      ..color = kBorder
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(Offset(headX, mid), Offset(size.width, mid), remaining);

    final played = Paint()
      ..color = kAccent
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final path = Path()..moveTo(0, mid);
    for (double x = 0; x <= headX; x += 2) {
      final distToHead = headX - x;
      final taper = math.min(1.0, distToHead / 16);
      final y = animate
          ? mid + math.sin(x / wavelength * 2 * math.pi - phase) * amp * taper
          : mid;
      path.lineTo(x, y);
    }
    canvas.drawPath(path, played);

    final thumb = Paint()..color = kAccent;
    canvas.drawCircle(Offset(headX, mid), 6, thumb);
  }

  @override
  bool shouldRepaint(_SquigglyPainter old) =>
      old.frac != frac || old.phase != phase || old.animate != animate;
}
