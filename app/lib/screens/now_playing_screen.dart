import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/cover.dart';

class NowPlayingScreen extends StatelessWidget {
  const NowPlayingScreen({super.key});

  String _fmt(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    final api = context.read<Api>();
    final track = player.current;

    return Scaffold(
      appBar: AppBar(title: const Text('Now Playing')),
      body: track == null
          ? const Center(child: Text('Nothing playing', style: TextStyle(color: kMuted)))
          : Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                children: [
                  const Spacer(),
                  Cover(url: api.trackCoverUrl(track.id), size: 280, radius: 16),
                  const SizedBox(height: 32),
                  Text(track.title,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 6),
                  Text(track.artistName, style: const TextStyle(color: kMuted, fontSize: 16)),
                  const SizedBox(height: 24),
                  _ProgressBar(player: player, fmt: _fmt),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      IconButton(
                        iconSize: 40,
                        icon: const Icon(Icons.skip_previous),
                        onPressed: player.previous,
                      ),
                      const SizedBox(width: 12),
                      Container(
                        decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
                        child: IconButton(
                          iconSize: 44,
                          color: Colors.black,
                          icon: Icon(player.playing ? Icons.pause : Icons.play_arrow),
                          onPressed: player.toggle,
                        ),
                      ),
                      const SizedBox(width: 12),
                      IconButton(
                        iconSize: 40,
                        icon: const Icon(Icons.skip_next),
                        onPressed: player.next,
                      ),
                    ],
                  ),
                  const Spacer(),
                ],
              ),
            ),
    );
  }
}

class _ProgressBar extends StatelessWidget {
  final PlayerModel player;
  final String Function(Duration) fmt;
  const _ProgressBar({required this.player, required this.fmt});

  @override
  Widget build(BuildContext context) {
    final dur = player.duration;
    final pos = player.position;
    final max = dur.inMilliseconds.toDouble();
    final value = pos.inMilliseconds.toDouble().clamp(0.0, max == 0 ? 1.0 : max);
    return Column(
      children: [
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            trackHeight: 3,
            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
          ),
          child: Slider(
            value: value,
            max: max == 0 ? 1.0 : max,
            activeColor: kAccent2,
            inactiveColor: kPanel2,
            onChanged: (v) => player.seek(Duration(milliseconds: v.toInt())),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(fmt(pos), style: const TextStyle(color: kMuted, fontSize: 12)),
              Text(fmt(dur), style: const TextStyle(color: kMuted, fontSize: 12)),
            ],
          ),
        ),
      ],
    );
  }
}
