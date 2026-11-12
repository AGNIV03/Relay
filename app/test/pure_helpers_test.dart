import 'package:flutter_test/flutter_test.dart';
import 'package:stream_app/api.dart';
import 'package:stream_app/loudness.dart';
import 'package:stream_app/widgets/cover.dart';

void main() {
  group('Api.normalizeServerUrl', () {
    test('adds https:// when no scheme is given and trims slashes/whitespace', () {
      expect(Api.normalizeServerUrl('  relay.example.com/ '), 'https://relay.example.com');
      expect(Api.normalizeServerUrl('relay.example.com///'), 'https://relay.example.com');
      expect(Api.normalizeServerUrl('https://relay.example.com/sub/'), 'https://relay.example.com/sub');
      expect(Api.normalizeServerUrl(''), '');
      expect(Api.normalizeServerUrl('   '), '');
    });

    test('upgrades plain http to https for public hosts', () {
      expect(Api.normalizeServerUrl('http://relay.example.com'), 'https://relay.example.com');
      expect(Api.normalizeServerUrl('http://relay.example.com:8080/x'), 'https://relay.example.com:8080/x');
    });

    test('keeps http for localhost, .local and private LAN addresses', () {
      for (final u in [
        'http://localhost:4000',
        'http://nas.local',
        'http://127.0.0.1:4000',
        'http://10.0.0.5',
        'http://192.168.1.20:3000',
        'http://172.16.0.1',
        'http://172.31.255.255',
      ]) {
        expect(Api.normalizeServerUrl(u), u, reason: u);
      }
    });

    test('172.x outside 16-31 is public', () {
      expect(Api.normalizeServerUrl('http://172.32.0.1'), 'https://172.32.0.1');
      expect(Api.normalizeServerUrl('http://172.15.0.1'), 'https://172.15.0.1');
    });
  });

  group('coverCacheKey', () {
    test('drops the rotating token so the cache survives token refreshes', () {
      expect(coverCacheKey('https://h/api/stream/t1/cover?token=abc'), 'https://h/api/stream/t1/cover');
      expect(
        coverCacheKey('https://h/api/stream/t1/cover?token=abc'),
        coverCacheKey('https://h/api/stream/t1/cover?token=xyz'),
      );
    });

    test('keeps other query parameters', () {
      expect(coverCacheKey('https://h/api/playlists/p/cover?v=3&token=abc'), 'https://h/api/playlists/p/cover?v=3');
      expect(coverCacheKey('https://h/c?token=a&v=1&token=b'), 'https://h/c?v=1');
    });

    test('URLs without a token are unchanged', () {
      expect(coverCacheKey('https://h/c?v=1'), 'https://h/c?v=1');
      expect(coverCacheKey('https://h/c'), 'https://h/c');
    });
  });

  group('loudnessNormFactor', () {
    // Same table as web/test/loudness.test.ts.
    const table = <(double, double)>[
      (-14, 1),
      (-20, 1),
      (-70, 1),
      (-8, 0.501187),
      (-11, 0.707946),
      (-2, 0.251189),
      (0, 0.25),
      (10, 0.25),
    ];
    for (final (lufs, gain) in table) {
      test('$lufs LUFS -> $gain', () {
        expect(loudnessNormFactor(lufs, normalize: true), closeTo(gain, 1e-6));
      });
    }

    test('1.0 when off, unmeasured or non-finite', () {
      expect(loudnessNormFactor(-2, normalize: false), 1.0);
      expect(loudnessNormFactor(null, normalize: true), 1.0);
      expect(loudnessNormFactor(double.nan, normalize: true), 1.0);
    });
  });
}
