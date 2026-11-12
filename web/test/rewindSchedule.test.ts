// RewindSchedule (components/rewind/schedule.ts) — must match the Flutter app's
// RewindSchedule exactly (app/test/rewind_schedule_test.dart has the same table).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RewindSchedule } from "../src/components/rewind/schedule";

// Local-time dates (the schedule reads getMonth/getDate in the viewer's zone).
const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h);

describe("RewindSchedule", () => {
  const table: Array<[Date, number | null, number | null]> = [
    // date              homeYear  profileYear
    [d(2025, 12, 19, 23), null, 2024], // last moment before this year's Rewind
    [d(2025, 12, 20, 0), 2025, null], //  Dec 20: this year's Rewind on Home
    [d(2025, 12, 31, 23), 2025, null],
    [d(2026, 1, 1, 0), 2025, null], //   New Year: still last year's on Home
    [d(2026, 1, 7, 23), 2025, null], //  Jan 7: last day on Home
    [d(2026, 1, 8, 0), null, 2025], //   Jan 8: moves to Profile
    [d(2026, 6, 15), null, 2025],
    [d(2026, 12, 19), null, 2025],
    [d(2026, 12, 20), 2026, null],
    [d(2024, 2, 29), null, 2023], //     leap day
  ];

  for (const [when, home, profile] of table) {
    it(`${when.toDateString()} ${when.getHours()}h → home ${home}, profile ${profile}`, () => {
      assert.equal(RewindSchedule.homeYear(when), home);
      assert.equal(RewindSchedule.profileYear(when), profile);
    });
  }

  it("exactly one of home/profile is set on every day of the year", () => {
    for (let t = d(2027, 1, 1).getTime(); t < d(2028, 1, 1).getTime(); t += 86_400_000) {
      const when = new Date(t);
      const h = RewindSchedule.homeYear(when);
      const p = RewindSchedule.profileYear(when);
      assert.ok((h === null) !== (p === null), when.toDateString());
    }
  });

  it("defaults to now", () => {
    const h = RewindSchedule.homeYear();
    const p = RewindSchedule.profileYear();
    assert.ok((h === null) !== (p === null));
  });
});
