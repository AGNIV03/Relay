import 'package:flutter_test/flutter_test.dart';
import 'package:stream_app/format.dart';
import 'package:stream_app/models.dart';

void main() {
  group('Track JSON', () {
    test('fromJson parses nested artist/album, uploader and loudness', () {
      final t = Track.fromJson({
        'id': 't1',
        'title': 'Song',
        'duration': 123.4,
        'trackNo': 3,
        'artist': {'id': 'a1', 'name': 'Band'},
        'album': {'id': 'al1', 'title': 'Record'},
        'uploader': {'username': 'alice'},
        'loudnessLufs': -9,
      });
      expect(t.id, 't1');
      expect(t.title, 'Song');
      expect(t.artistName, 'Band');
      expect(t.albumTitle, 'Record');
      expect(t.duration, closeTo(123.4, 0.001));
      expect(t.trackNo, 3);
      expect(t.uploaderName, 'alice');
      expect(t.loudnessLufs, -9.0); // int in JSON -> double
    });

    test('fromJson tolerates missing optional fields', () {
      final t = Track.fromJson({'id': 't2'});
      expect(t.title, 'Untitled');
      expect(t.duration, 0);
      expect(t.artistName, '');
      expect(t.albumTitle, '');
      expect(t.loudnessLufs, isNull);
    });

    test('toJson round-trips what the offline cache needs', () {
      final t = Track.fromJson({
        'id': 't3',
        'title': 'X',
        'duration': 10,
        'artist': {'id': 'a', 'name': 'A'},
        'album': {'id': 'b', 'title': 'B'},
        'loudnessLufs': -11.5,
      });
      final back = Track.fromJson(t.toJson());
      expect(back.id, 't3');
      expect(back.artistName, 'A');
      expect(back.albumTitle, 'B');
      expect(back.loudnessLufs, -11.5);
    });
  });

  group('format', () {
    test('formatPlaylistLength', () {
      expect(formatPlaylistLength(0), '0 sec');
      expect(formatPlaylistLength(29), '29 sec');
      expect(formatPlaylistLength(12 * 60), '12 min');
      expect(formatPlaylistLength(60 * 60), '1 hr');
      expect(formatPlaylistLength(65 * 60 + 10), '1 hr 5 min');
    });

    test('totalDurationSeconds rounds each track', () {
      expect(totalDurationSeconds([1.4, 1.6, 10]), 13);
      expect(totalDurationSeconds(const []), 0);
    });
  });
}
