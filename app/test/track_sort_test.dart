import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stream_app/models.dart';
import 'package:stream_app/widgets/track_sort.dart';

Track _t(String id, String title,
        {String? artist, String? album, double duration = 0, String? createdAt}) =>
    Track(
      id: id,
      title: title,
      duration: duration,
      artist: artist == null ? null : Artist(id: 'ar_$id', name: artist),
      album: album == null ? null : Album(id: 'al_$id', title: album),
      createdAt: createdAt,
    );

List<String> _ids(List<Track> l) => [for (final t in l) t.id];

void main() {
  // Same fixture/expectations as web/test/trackSort.test.ts.
  final lib = [
    _t('a', 'beta', artist: 'Zed', album: 'Mid', duration: 200, createdAt: '2024-03-01T00:00:00Z'),
    _t('b', 'Alpha', artist: 'abba', album: 'zzz', duration: 100, createdAt: '2024-01-01T00:00:00Z'),
    _t('c', 'alpha', artist: 'Mu', duration: 300, createdAt: '2024-02-01T00:00:00Z'),
  ];

  group('sortTracks', () {
    test('custom keeps (or reverses) the order as a copy', () {
      final out = sortTracks(lib, TrackOrder.custom, true);
      expect(_ids(out), ['a', 'b', 'c']);
      expect(identical(out, lib), isFalse);
      expect(_ids(sortTracks(lib, TrackOrder.custom, false)), ['c', 'b', 'a']);
    });

    test('title is case-insensitive and stable for ties in both directions', () {
      expect(_ids(sortTracks(lib, TrackOrder.title, true)), ['b', 'c', 'a']);
      expect(_ids(sortTracks(lib, TrackOrder.title, false)), ['a', 'b', 'c']);
    });

    test('artist / album (missing album sorts first ascending)', () {
      expect(_ids(sortTracks(lib, TrackOrder.artist, true)), ['b', 'c', 'a']);
      expect(_ids(sortTracks(lib, TrackOrder.album, true)), ['c', 'a', 'b']);
    });

    test('duration', () {
      expect(_ids(sortTracks(lib, TrackOrder.duration, true)), ['b', 'a', 'c']);
      expect(_ids(sortTracks(lib, TrackOrder.duration, false)), ['c', 'a', 'b']);
    });

    test('added prefers the addedAt map, falling back to the library date', () {
      expect(_ids(sortTracks(lib, TrackOrder.added, true)), ['b', 'c', 'a']);
      expect(
          _ids(sortTracks(lib, TrackOrder.added, true,
              addedAt: {'a': '2020-01-01T00:00:00Z', 'c': null})),
          ['a', 'b', 'c']);
    });

    test('does not mutate the input', () {
      final before = _ids(lib);
      for (final o in TrackOrder.values) {
        sortTracks(lib, o, false);
      }
      expect(_ids(lib), before);
    });
  });

  group('TrackSortState', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('pick flips direction on the active order, resets to ascending on a new one', () {
      final s = TrackSortState();
      expect([s.order, s.asc], [TrackOrder.custom, true]);
      s.pick(TrackOrder.title);
      expect([s.order, s.asc], [TrackOrder.title, true]);
      s.pick(TrackOrder.title);
      expect([s.order, s.asc], [TrackOrder.title, false]);
      s.pick(TrackOrder.artist);
      expect([s.order, s.asc], [TrackOrder.artist, true]);
    });

    test('save/load round-trips under sort_<key> (same format as the web app)', () async {
      final s = TrackSortState()
        ..order = TrackOrder.duration
        ..asc = false;
      await s.save('pl1');
      final p = await SharedPreferences.getInstance();
      expect(p.getString('sort_pl1'), 'duration:desc');
      final l = TrackSortState();
      await l.load('pl1');
      expect([l.order, l.asc], [TrackOrder.duration, false]);
    });

    test('load keeps defaults when nothing is stored; unknown orders fall back to custom', () async {
      SharedPreferences.setMockInitialValues({'sort_bad': 'bogus:desc'});
      final none = TrackSortState();
      await none.load('missing');
      expect([none.order, none.asc], [TrackOrder.custom, true]);
      final bad = TrackSortState();
      await bad.load('bad');
      expect([bad.order, bad.asc], [TrackOrder.custom, false]);
    });
  });
}
