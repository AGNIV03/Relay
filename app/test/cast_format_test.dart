// Chromecast helpers: which files go to the receiver as-is (range-seekable) vs.
// as a transcode, and the `start=` offset used to seek a transcode. The same
// format table is asserted in web/test/castFormat.test.ts.
import 'package:flutter_test/flutter_test.dart';
import 'package:stream_app/cast/cast_controller.dart';
import 'package:stream_app/cast/cast_format.dart';

void main() {
  group('nativeCastType', () {
    test('passes formats the Default Media Receiver decodes', () {
      expect(nativeCastType('mp3', 320), 'audio/mpeg');
      expect(nativeCastType('MP3', null), 'audio/mpeg');
      expect(nativeCastType('aac', 256), 'audio/aac');
      expect(nativeCastType('m4a', 256), 'audio/mp4');
      expect(nativeCastType('opus', 160), 'audio/ogg');
      expect(nativeCastType('flac', 1411), 'audio/flac');
      expect(nativeCastType('wav', 1411), 'audio/wav');
    });
    test("transcodes what it can't", () {
      expect(nativeCastType('m4a', 1800), isNull);
      expect(nativeCastType('flac', 4608), isNull);
      expect(nativeCastType('flac', null), isNull);
      expect(nativeCastType('wma', 192), isNull);
      expect(nativeCastType(null, null), isNull);
    });
  });

  group('CastItem.withOffset', () {
    const url = 'https://x/api/stream/t1?token=a&format=mp3&bitrate=320';
    const item = CastItem(
        trackId: 't1',
        url: url,
        contentType: 'audio/mpeg',
        title: 'T',
        artist: 'A',
        album: '',
        durationSecs: 200,
        transcoded: true);
    test('adds, replaces and drops start=; duration shrinks by the offset', () {
      final a = item.withOffset(42.5);
      expect(a.url, '$url&start=42.500');
      expect(a.offsetSecs, 42.5);
      expect(a.toMedia()['duration'], 157.5);
      expect(a.withOffset(10).url, '$url&start=10.000');
      expect(a.withOffset(0).url, url);
    });
    test('clamps an offset past the end', () {
      expect(item.withOffset(500).offsetSecs, 199);
    });
  });
}
