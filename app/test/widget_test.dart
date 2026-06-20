// Basic smoke test for the Stream app models.
import 'package:flutter_test/flutter_test.dart';
import 'package:stream_app/models.dart';

void main() {
  test('Track.fromJson parses nested artist/album', () {
    final t = Track.fromJson({
      'id': 't1',
      'title': 'Song',
      'duration': 123.4,
      'artist': {'id': 'a1', 'name': 'Band'},
      'album': {'id': 'al1', 'title': 'Record'},
    });
    expect(t.id, 't1');
    expect(t.title, 'Song');
    expect(t.artistName, 'Band');
    expect(t.albumTitle, 'Record');
    expect(t.duration, closeTo(123.4, 0.001));
  });
}
