import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../theme.dart';

/// Pixel-style "squiggly" seek bar: the played portion is a slow, calm ocean-like
/// wave; the rest is a flat line, with a thumb at the play head. Tap or drag to seek.
class SquigglyProgress extends StatefulWidget {
  final Duration position;
  final Duration duration;
  final bool playing;
  final ValueChanged<Duration> onSeek;
  final double height;
  // false = a still, flat bar (no animation clock at all). Used on desktop, where
  // a constantly redrawing wave isn't worth the CPU/GPU.
  final bool animated;

  const SquigglyProgress({
    super.key,
    required this.position,
    required this.duration,
    required this.playing,
    required this.onSeek,
    this.height = 28,
    this.animated = true,
  });

  @override
  State<SquigglyProgress> createState() => _SquigglyProgressState();
}

class _SquigglyProgressState extends State<SquigglyProgress> with WidgetsBindingObserver {
  // The wave animates ONLY while playing and the app is visible, driven by a
  // ~30fps timer rather than a vsync ticker. A repeating AnimationController ran
  // the frame pipeline at the display's full refresh rate (60–144Hz) the whole
  // time the bar was on screen — even paused — which kept the desktop app busy.
  // The wave is slow and calm, so 30fps looks the same.
  static const _frame = Duration(milliseconds: 33);
  static const _radPerSec = 1.08; // same speed as the old 0.018 rad/frame at 60fps
  Timer? _timer;
  final _clock = Stopwatch();
  double _phase = 0;
  bool _visible = true;
  double? _dragFrac; // set only while actively dragging

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _sync();
  }

  @override
  void didUpdateWidget(covariant SquigglyProgress old) {
    super.didUpdateWidget(old);
    if (old.playing != widget.playing || old.animated != widget.animated) _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Minimised / hidden window: nothing to draw, so stop the clock entirely.
    _visible = state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;
    _sync();
  }

  void _sync() {
    final run = widget.animated && widget.playing && _visible;
    if (run && _timer == null) {
      _clock.start();
      _timer = Timer.periodic(_frame, (_) {
        if (_dragFrac != null || !mounted) return;
        setState(() => _phase = _clock.elapsedMilliseconds / 1000 * _radPerSec);
      });
    } else if (!run && _timer != null) {
      _timer!.cancel();
      _timer = null;
      _clock.stop();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  void _seek(double localX, double width) {
    final frac = (localX / width).clamp(0.0, 1.0);
    widget.onSeek(Duration(milliseconds: (frac * widget.duration.inMilliseconds).round()));
  }

  void _drag(double localX, double width) {
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
          // A plain tap just seeks — it must NOT latch _dragFrac, or the bar
          // would freeze there while the song keeps playing.
          onTapDown: (d) => _seek(d.localPosition.dx, w),
          onHorizontalDragStart: (d) => _drag(d.localPosition.dx, w),
          onHorizontalDragUpdate: (d) => _drag(d.localPosition.dx, w),
          onHorizontalDragEnd: (_) => setState(() => _dragFrac = null),
          onHorizontalDragCancel: () => setState(() => _dragFrac = null),
          child: SizedBox(
            width: double.infinity,
            height: widget.height,
            // Own layer: repainting the wave doesn't repaint the player bar.
            child: RepaintBoundary(
              child: CustomPaint(
                painter: _SquigglyPainter(
                    frac: frac, phase: _phase, animate: widget.animated && widget.playing),
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
    const amp = 5.0; // gentle height
    const wavelength = 80.0; // long, rolling waves

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
      final taper = math.min(1.0, distToHead / 24); // settle to the thumb
      final y = animate
          ? mid + math.sin(x / wavelength * 2 * math.pi - phase) * amp * taper
          : mid;
      path.lineTo(x, y);
    }
    canvas.drawPath(path, played);

    canvas.drawCircle(Offset(headX, mid), 6, Paint()..color = kAccent);
  }

  @override
  bool shouldRepaint(_SquigglyPainter old) =>
      old.frac != frac || old.phase != phase || old.animate != animate;
}
