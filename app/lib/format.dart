/// "12 min" or "1 hr 5 min" — used for total playlist length.
String formatPlaylistLength(int totalSeconds) {
  final m = (totalSeconds / 60).round();
  if (m < 1) return '$totalSeconds sec';
  if (m < 60) return '$m min';
  final h = m ~/ 60;
  final rem = m % 60;
  return rem == 0 ? '$h hr' : '$h hr $rem min';
}

/// Sum of track durations (seconds) for a list of tracks.
int totalDurationSeconds(Iterable<num> durations) =>
    durations.fold<int>(0, (sum, d) => sum + d.round());
