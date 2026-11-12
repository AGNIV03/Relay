import 'package:flutter_test/flutter_test.dart';
import 'package:stream_app/screens/rewind_screen.dart';

void main() {
  // Same table as web/test/rewindSchedule.test.ts — the two must agree.
  final table = <(DateTime, int?, int?)>[
    // date                           homeYear profileYear
    (DateTime(2025, 12, 19, 23, 59), null, 2024), // last moment before this year's Rewind
    (DateTime(2025, 12, 20), 2025, null), //         Dec 20: this year's Rewind on Home
    (DateTime(2025, 12, 31, 23), 2025, null),
    (DateTime(2026, 1, 1), 2025, null), //           New Year: still last year's on Home
    (DateTime(2026, 1, 7, 23, 59), 2025, null), //   Jan 7: last day on Home
    (DateTime(2026, 1, 8), null, 2025), //           Jan 8: moves to Profile
    (DateTime(2026, 6, 15), null, 2025),
    (DateTime(2026, 12, 19), null, 2025),
    (DateTime(2026, 12, 20), 2026, null),
    (DateTime(2024, 2, 29), null, 2023), //          leap day
  ];

  group('RewindSchedule', () {
    for (final (date, home, profile) in table) {
      test('$date -> home $home, profile $profile', () {
        expect(RewindSchedule.homeYear(date), home);
        expect(RewindSchedule.profileYear(date), profile);
      });
    }

    test('exactly one of home/profile is set on every day of the year', () {
      for (var d = DateTime(2027, 1, 1); d.year == 2027; d = DateTime(d.year, d.month, d.day + 1)) {
        final h = RewindSchedule.homeYear(d);
        final p = RewindSchedule.profileYear(d);
        expect((h == null) != (p == null), isTrue, reason: '$d');
      }
    });

    test('defaults to now', () {
      expect((RewindSchedule.homeYear() == null) != (RewindSchedule.profileYear() == null), isTrue);
    });
  });
}
