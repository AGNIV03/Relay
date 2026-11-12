import 'dart:math' as math;

/// Loudness normalization gain. Spec formula (identical on every client, see
/// web/src/lib/loudness.ts): target -14 LUFS, attenuation only, clamped to
/// [0.25, 1]. 1.0 when normalization is off or the track isn't measured yet.
double loudnessNormFactor(double? lufs, {required bool normalize}) {
  if (!normalize || lufs == null || !lufs.isFinite) return 1.0;
  return math.pow(10, (-14 - lufs) / 20).toDouble().clamp(0.25, 1.0);
}
