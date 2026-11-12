import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stream_app/settings.dart';

/// Let the fire-and-forget `_save()` finish.
Future<void> _flush() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final s = AppSettings.instance; // a singleton: reset what each test touches

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'set_autoplay': false,
      'set_fade_seconds': 4,
      'set_recent_searches': ['stored'],
    });
    await s.load();
  });
  setUp(() => s.clearRecentSearches());

  test('load reads persisted values and keeps defaults for the rest', () {
    expect(s.autoplay, isFalse);
    expect(s.fadeSeconds, 4);
    expect(s.normalize, isTrue); // default
    expect(s.downloadWifiOnly, isFalse); // default
  });

  group('recent searches', () {
    test('most recent first, trimmed, case-insensitive de-dupe', () {
      s.addRecentSearch('Daft Punk');
      s.addRecentSearch('  radiohead ');
      s.addRecentSearch('daft punk');
      expect(s.recentSearches, ['daft punk', 'radiohead']);
    });

    test('ignores blank queries', () {
      s.addRecentSearch('x');
      s.addRecentSearch('   ');
      expect(s.recentSearches, ['x']);
    });

    test('keeps at most maxRecent (12)', () {
      for (var i = 0; i < 20; i++) {
        s.addRecentSearch('q$i');
      }
      expect(s.recentSearches.length, AppSettings.maxRecent);
      expect(s.recentSearches.first, 'q19');
      expect(s.recentSearches.last, 'q8');
    });

    test('remove is exact-match; clear empties', () {
      s.addRecentSearch('a');
      s.addRecentSearch('b');
      s.removeRecentSearch('A');
      expect(s.recentSearches, ['b', 'a']);
      s.removeRecentSearch('a');
      expect(s.recentSearches, ['b']);
      s.clearRecentSearches();
      expect(s.recentSearches, isEmpty);
    });

    test('changes are persisted and notify listeners', () async {
      var notified = 0;
      void listener() => notified++;
      s.addListener(listener);
      s.addRecentSearch('persist me');
      s.removeListener(listener);
      await _flush();
      final p = await SharedPreferences.getInstance();
      expect(p.getStringList('set_recent_searches'), ['persist me']);
      expect(notified, 1);
    });
  });

  test('fade seconds are clamped to 0..12', () async {
    s.setFadeSeconds(30);
    expect(s.fadeSeconds, 12);
    s.setFadeSeconds(-2);
    expect(s.fadeSeconds, 0);
    s.setFadeSeconds(4);
    await _flush();
    expect((await SharedPreferences.getInstance()).getInt('set_fade_seconds'), 4);
  });
}
